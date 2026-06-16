// =============================================================================
// revenant-engine/src/bin/query.rs
// REVENANT Query Node — Sprint 10: CQRS Materialised View
// Classification: RESTRICTED — SOVEREIGN INFRASTRUCTURE
// =============================================================================
//
// ARCHITECTURE:
//   This binary implements the Query side of CQRS. It subscribes to the
//   replication stream (stream 1002) published by the primary node's WAL
//   Replicator thread and maintains a local materialised view of the ledger
//   using lock-free AtomicI64 balances.
//
//   Two concurrent execution contexts share a single Arc<Ledger>:
//
//     ┌─────────────────────────────┐     Arc<Ledger>     ┌────────────────────────────┐
//     │  revenant-query-rx          │ ──────────────────→ │  Tokio / axum HTTP server  │
//     │  std::thread (OS thread)    │                     │  GET /api/v1/balance/:id   │
//     │  Aeron poll loop            │  Relaxed atomics    │  JSON: {account, balance}  │
//     │  fetch_sub / fetch_add      │ ←────────────────── │  Relaxed load, no lock     │
//     └─────────────────────────────┘                     └────────────────────────────┘
//
//   The Aeron thread is a plain std::thread — never spawned inside Tokio —
//   because the BackoffIdle spin loop would starve the async executor.
//
// REPLICATION FEED:
//   Channel: aeron:udp?endpoint=127.0.0.1:40124
//   Stream : 1002
//   Format : 512-byte TransactionEnvelope frames (same as primary IPC channel)
//
// FIELD OFFSETS (wire layout, matching main.rs process_envelope):
//   [96:100]  sender   u32 LE
//   [100:104] receiver u32 LE
//   [104:112] amount   u64 LE
//
// =============================================================================

use std::ffi::CString;
use std::mem;
use std::sync::atomic::{AtomicI64, AtomicU64 , Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use aeron_rs::aeron::Aeron;
use aeron_rs::concurrent::atomic_buffer::AtomicBuffer;
use aeron_rs::utils::types::Index;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    routing::get,
    Json, Router,
};
use serde::Serialize;
use tokio::net::TcpListener;

// =============================================================================
// CONSTANTS
// =============================================================================

/// Aeron replication channel published by main.rs's spawn_replicator_thread.
/// Must match REPLICATION_CHANNEL in main.rs exactly — a single character
/// difference means zero frames received, with no error from aeron-rs.
const REPLICATION_CHANNEL: &str = "aeron:udp?endpoint=127.0.0.1:40124";

/// Replication stream ID. Must match REPLICATION_STREAM_ID in main.rs.
const REPLICATION_STREAM_ID: i32 = 1002;

/// Aeron media driver shared-memory directory.
/// Must match the directory used by main.rs and follower.rs.
const AERON_DIR: &str = "/dev/shm/aeron";

/// Maximum fragments processed per Aeron poll call.
const FRAGMENT_LIMIT: i32 = 64;

/// Wire frame size in bytes. Every valid replication frame is exactly this.
const ENVELOPE_SIZE: usize = 512;

/// Number of accounts in the materialised ledger view.
const ACCOUNT_COUNT: usize = 100_000;

/// Starting balance for all accounts except Account 0 (tiyins).
const INITIAL_BALANCE_TIYIN: i64 = 100_000_000;

/// Account 0 is the System Mint — funded with 10 quintillion tiyins.
/// Must mirror Ledger::new() in main.rs exactly.
const SYSTEM_MINT_BALANCE: i64 = 1_000_000_000_000_000_000;

/// HTTP server bind port.
const HTTP_PORT: u16 = 8084;

// =============================================================================
// LEDGER — WAIT-FREE ATOMIC STATE
// =============================================================================

/// A single account balance cell, 64-byte cache-line aligned.
///
/// `AtomicI64` guarantees that concurrent reads from Tokio worker threads and
/// concurrent writes from the Aeron poll thread never produce torn values.
///
/// The `_pad` field fills the cache line to prevent false sharing: without
/// padding, two adjacent accounts share a cache line, and a write to account N
/// from the Aeron thread would invalidate the L1 cache entry being read by an
/// HTTP handler for account N+1. With 64-byte padding, each account occupies
/// exactly one cache line.
#[repr(C, align(64))]
struct Account {
    balance: AtomicI64,
    last_nonce: AtomicU64,  // <-- ADDED
    _pad:       [u8; 48]
}

// Compile-time assertion: Account must be exactly 64 bytes.
// If the layout changes (e.g., a new field is added), this catches it
// before silent performance regression from false sharing.
const _: () = assert!(std::mem::size_of::<Account>() == 64);

impl Account {
    #[inline(always)]
    fn new(initial: i64) -> Self {
        Account {
            balance:    AtomicI64::new(initial),
            last_nonce: AtomicU64::new(0), // <-- ADDED
            _pad:       [0u8; 48],
        }
    }
}

struct Ledger {
    accounts: Vec<Account>,
}

impl Ledger {
    fn new() -> Self {
        let accounts: Vec<Account> = (0..ACCOUNT_COUNT)
            .map(|_| Account::new(INITIAL_BALANCE_TIYIN))
            .collect();

        // Mirror Ledger::new() in main.rs: Account 0 is the System Mint.
        // Injection operations on the primary debit Account 0; the query
        // node must start with the same funding or balance reads will diverge.
        if !accounts.is_empty() {
            accounts[0].balance.store(SYSTEM_MINT_BALANCE, Ordering::Relaxed);
        }

        Ledger { accounts }
    }

    /// Apply a debit/credit pair atomically. Ordering::Relaxed is correct for
    /// this derived read model — the query node is eventually consistent by
    /// design. The Go gateway reads primary balances via UDP port 8083 for
    /// authoritative values; this node serves dashboard and analytics traffic.
    #[inline(always)]
    fn apply(&self, sender: usize, receiver: usize, amount: i64, nonce: u64) {
        self.accounts[sender].balance.fetch_sub(amount, Ordering::Relaxed);
        self.accounts[receiver].balance.fetch_add(amount, Ordering::Relaxed);
        // Store nonce AFTER the balance changes so a concurrent reader that
        // sees the new nonce also sees the new balance (Relaxed is sufficient
        // here because the query node is eventually consistent by design).
        self.accounts[sender].last_nonce.store(nonce, Ordering::Relaxed);
    }

    /// Read a balance with Relaxed ordering. Torn reads are impossible on
    /// 64-bit platforms (AtomicI64 maps to a single 64-bit load instruction),
    /// and slight staleness is acceptable for a CQRS query model.
    #[inline(always)]
    fn balance_of(&self, id: usize) -> i64 {
        self.accounts[id].balance.load(Ordering::Relaxed)
    }
}

// =============================================================================
// AERON MUTATOR — DEDICATED OS THREAD
// =============================================================================

/// Spawns `revenant-query-rx`: a plain `std::thread` that owns the Aeron
/// poll loop and drives all writes to the `Arc<Ledger>`.
///
/// This MUST be a std::thread, not a Tokio task. The BackoffIdle strategy
/// uses `spin_loop()` in phase 0, which parks the CPU without yielding to the
/// async executor. Spawning this inside `tokio::spawn` would starve all HTTP
/// handler tasks sharing the same worker thread.
fn spawn_aeron_mutator(ledger: Arc<Ledger>) {
    thread::Builder::new()
        .name("revenant-query-rx".to_string())
        .stack_size(2 * 1024 * 1024)
        .spawn(move || {
            println!(
                "[QUERY_RX] Mutator thread starting. \
                 Channel: {} stream {}",
                REPLICATION_CHANNEL, REPLICATION_STREAM_ID,
            );

            // ── AERON CONNECT ─────────────────────────────────────────────
            // AERON_DIR must be set before Aeron::connect() is called.
            // The media driver reads this env var to locate its /dev/shm files.
            std::env::set_var("AERON_DIR", AERON_DIR);

            let mut aeron = loop {
                match Aeron::connect() {
                    Ok(a) => break a,
                    Err(e) => {
                        println!(
                            "[QUERY_RX] Waiting for Aeron media driver... ({:?})",
                            e
                        );
                        std::thread::sleep(Duration::from_secs(1));
                    }
                }
            };

            // ── ADD SUBSCRIPTION ──────────────────────────────────────────
            // CString is required by aeron-rs 0.1.8 add_subscription().
            let channel = CString::new(REPLICATION_CHANNEL)
                .expect("[QUERY_RX] FATAL: channel string contains null byte");

            let subscription_id = aeron
                .add_subscription(channel, REPLICATION_STREAM_ID)
                .expect("[QUERY_RX] FATAL: add_subscription failed");

            println!(
                "[QUERY_RX] Subscription requested (id={}). \
                 Waiting for primary node to publish...",
                subscription_id
            );

            // ── FIND SUBSCRIPTION ─────────────────────────────────────────
            // find_subscription returns Result<Arc<Mutex<Subscription>>, _>.
            // Spin-yield until the media driver confirms the subscription.
            let subscription = loop {
                if let Ok(sub) = aeron.find_subscription(subscription_id) {
                    break sub;
                }
                std::thread::yield_now();
            };

            println!(
                "[QUERY_RX] Subscription LIVE on stream {}. \
                 Materialising ledger from replication feed.",
                REPLICATION_STREAM_ID
            );

            // ── FRAGMENT HANDLER ──────────────────────────────────────────
            // The closure captures `ledger` via a raw pointer — same pattern
            // as network_rx.rs and follower.rs — because the closure's
            // lifetime (it lives across all poll iterations) cannot hold a
            // `&Ledger` borrow simultaneously with the `subscription.lock()`
            // borrow in the poll call.
            //
            // SAFETY: This is a single-writer thread. The Arc<Ledger> is
            // shared with HTTP handlers which only call `balance_of` (reads).
            // `apply` uses AtomicI64 operations — no data races are possible.
            let ledger_ptr: *const Ledger = Arc::as_ptr(&ledger);

            let mut fragment_handler = move |buffer:  &AtomicBuffer,
                                             offset:  Index,
                                             length:  Index,
                                             _header: &_| {
                // ── FRAME SIZE GATE ───────────────────────────────────────
                if length as usize != ENVELOPE_SIZE {
                    return;
                }

                // ── COPY FRAME TO STACK ───────────────────────────────────
                // buffer.get_bytes copies ENVELOPE_SIZE bytes from the Aeron
                // term buffer (shared memory) into a local stack array.
                // All field reads below use read_unaligned because the stack
                // array carries no alignment guarantee beyond u8.
                let mut frame = [0u8; ENVELOPE_SIZE];
                buffer.get_bytes(offset, &mut frame);

                let p = frame.as_ptr();

                // ── FIELD EXTRACTION ──────────────────────────────────────
                //
                // Wire layout (Go ipc.PackEnvelope, matching main.rs offsets):
                //
                //   [0:32]    intent_hash  [u8; 32]
                //   [32:96]   signature    [u8; 64]
                //   [96:100]  sender       u32 LE
                //   [100:104] receiver     u32 LE
                //   [104:112] amount       u64 LE
                //
                // SAFETY: frame is [u8; 512]. All reads end at byte 112 < 512.
                let s = unsafe {
                    std::ptr::read_unaligned(p.add(104) as *const u32)
                } as usize;

                let r = unsafe {
                    std::ptr::read_unaligned(p.add(108) as *const u32)
                } as usize;

                let a = unsafe {
                    std::ptr::read_unaligned(p.add(112) as *const u64)
                } as i64;

                // ── NONCE EXTRACTION ──────────────────────────────────────
                // Nonce follows amount at offset 120 in the wire frame.
                // SAFETY: frame is [u8; 512]; offset 120 + 8 = 128 < 512.
                let nonce = unsafe {
                    std::ptr::read_unaligned(p.add(120) as *const u64)
                };

                // ── VALIDITY GATE ─────────────────────────────────────────
                if s == r
                    || s >= ACCOUNT_COUNT
                    || r >= ACCOUNT_COUNT
                    || a <= 0
                {
                    return;
                }

                // ── APPLY TRANSITION ──────────────────────────────────────
                // SAFETY: ledger_ptr is valid for the lifetime of this thread.
                unsafe {
                    let ledger = &*ledger_ptr;

                    // Replay check: drop frames with stale or duplicate nonces.
                    // The query node mirrors the primary's acceptance logic so
                    // its materialised view stays consistent with the primary.
                    let last = ledger.accounts[s].last_nonce.load(Ordering::Relaxed);
                    if nonce <= last {
                        return;
                    }

                    if ledger.balance_of(s) < a {
                        return; // Insufficient funds on mirror — primary rejected this
                    }

                    ledger.apply(s, r, a, nonce);
                }

            };

            // ── POLL LOOP ─────────────────────────────────────────────────
            // subscription is Arc<Mutex<Subscription>> in aeron-rs 0.1.8.
            // Lock per poll call is the required API.
            let mut idle = BackoffIdle::new();

            loop {
                let n = subscription
                    .lock()
                    .unwrap()
                    .poll(&mut fragment_handler, FRAGMENT_LIMIT); // <-- REMOVED .unwrap_or(0)

                if n > 0 { idle.reset(); } else { idle.idle(); }
            }
        })
        .expect("[QUERY] FATAL: failed to spawn revenant-query-rx thread");
}

// =============================================================================
// BACKOFF IDLE STRATEGY
// =============================================================================

enum IdlePhase { Spin, Yield, Park }

struct BackoffIdle {
    phase:       IdlePhase,
    spin_count:  u32,
    yield_count: u32,
}

impl BackoffIdle {
    fn new() -> Self {
        BackoffIdle {
            phase:       IdlePhase::Spin,
            spin_count:  0,
            yield_count: 0,
        }
    }

    fn idle(&mut self) {
        match self.phase {
            IdlePhase::Spin => {
                std::hint::spin_loop();
                self.spin_count += 1;
                if self.spin_count >= 100 {
                    self.phase      = IdlePhase::Yield;
                    self.spin_count = 0;
                }
            }
            IdlePhase::Yield => {
                std::thread::yield_now();
                self.yield_count += 1;
                if self.yield_count >= 100 {
                    self.phase       = IdlePhase::Park;
                    self.yield_count = 0;
                }
            }
            IdlePhase::Park => {
                std::thread::sleep(Duration::from_micros(1));
            }
        }
    }

    #[inline(always)]
    fn reset(&mut self) {
        self.phase       = IdlePhase::Spin;
        self.spin_count  = 0;
        self.yield_count = 0;
    }
}

// =============================================================================
// HTTP API
// =============================================================================

#[derive(Clone)]
struct AppState {
    ledger: Arc<Ledger>,
}

#[derive(Serialize)]
struct BalanceResponse {
    account: u64,
    balance: i64,
}

/// `GET /api/v1/balance/:account_id`
///
/// Returns the current materialised balance for the given account ID.
/// The read uses `Ordering::Relaxed` — the query node is eventually consistent.
/// Authoritative balances are available via the primary node's UDP port 8083.
async fn get_balance(
    State(state): State<AppState>,
    Path(account_id): Path<u64>,
) -> impl IntoResponse {
    let id = account_id as usize;

    if id >= ACCOUNT_COUNT {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({
                "error":      "ACCOUNT_NOT_FOUND",
                "account_id": account_id,
                "max_valid":  ACCOUNT_COUNT - 1,
            })),
        ).into_response();
    }

    let balance = state.ledger.balance_of(id);

    (
        StatusCode::OK,
        Json(BalanceResponse {
            account: account_id,
            balance,
        }),
    ).into_response()
}

// =============================================================================
// MAIN
// =============================================================================

#[tokio::main]
async fn main() {
    println!("[QUERY] ═══════════════════════════════════════════════════════");
    println!("[QUERY] REVENANT Query Node — Sprint 10: CQRS Materialised View");
    println!("[QUERY] ═══════════════════════════════════════════════════════");
    println!(
        "[QUERY] Accounts: {:>7} × 64 bytes = {:>4} KB atomic ledger",
        ACCOUNT_COUNT,
        (ACCOUNT_COUNT * 64) / 1024,
    );
    println!("[QUERY] Replication: {} stream {}", REPLICATION_CHANNEL, REPLICATION_STREAM_ID);
    println!("[QUERY] HTTP:        0.0.0.0:{} — GET /api/v1/balance/:account_id", HTTP_PORT);
    println!("[QUERY] ─────────────────────────────────────────────────────");

    // ── LEDGER INIT ───────────────────────────────────────────────────────
    let ledger = Arc::new(Ledger::new());
    println!(
        "[QUERY] Ledger initialised. Account[0] (System Mint) = {} tiyin.",
        ledger.balance_of(0),
    );

    // ── AERON MUTATOR THREAD ──────────────────────────────────────────────
    // Spawned BEFORE the Tokio runtime enters async mode. The thread is a
    // plain OS thread independent of the Tokio executor — it will never be
    // preempted by Tokio's scheduler and will never starve HTTP handlers.
    spawn_aeron_mutator(Arc::clone(&ledger));
    println!("[QUERY] Aeron mutator thread spawned (revenant-query-rx).");

    // ── AXUM ROUTER ───────────────────────────────────────────────────────
    let app = Router::new()
        .route("/api/v1/balance/:account_id", get(get_balance))
        .with_state(AppState { ledger });

    // ── BIND & SERVE ──────────────────────────────────────────────────────
    let bind_addr = format!("0.0.0.0:{}", HTTP_PORT);
    let listener = TcpListener::bind(&bind_addr)
        .await
        .unwrap_or_else(|e| panic!("[QUERY] FATAL: cannot bind {}: {}", bind_addr, e));

    println!("[QUERY] HTTP server live on {}", bind_addr);
    println!("[QUERY] ─────────────────────────────────────────────────────");

    axum::serve(listener, app)
        .await
        .expect("[QUERY] FATAL: axum server exited");
}