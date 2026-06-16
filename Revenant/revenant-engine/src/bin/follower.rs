// =============================================================================
// revenant-engine/src/bin/follower.rs
// REVENANT EU Node — Cross-Region Follower
// Classification: RESTRICTED — SOVEREIGN INFRASTRUCTURE
// =============================================================================
//
// PURPOSE:
//   Standalone binary that subscribes to the primary node's replication feed
//   and maintains a byte-perfect mirror of the ledger state in local RAM.
//
// REPLICATION FEED:
//   Channel : aeron:udp?endpoint=127.0.0.1:40124
//   Stream  : 1002
//   Format  : Raw 512-byte TransactionEnvelope frames (identical wire format
//             to the primary node's IPC channel)
//
// ARCHITECTURAL INVARIANTS:
//   - Single-threaded. No ring buffer, no shared state.
//   - Mutation logic is identical to main.rs `process_envelope` (same offsets).
//   - No ACK channel. The EU node is read-only from the network's perspective.
//   - The Ledger struct mirrors Ledger in main.rs but carries no ack_tx.
//
// AERON-RS 0.1.8 API NOTES (matching main.rs / network_rx.rs exactly):
//   - Aeron::connect() reads AERON_DIR from env. Set before calling.
//   - add_subscription() expects CString channel.
//   - find_subscription() returns Result<Arc<Mutex<Subscription>>, _>.
//   - subscription.lock().unwrap().poll() drives the fragment handler.
//   - buffer.get_bytes(offset, &mut slice) copies from the term buffer.
//
// TO BUILD:
//   cargo build --release --bin follower
//
// =============================================================================

use std::ffi::CString;
use std::mem;
use std::time::Duration;

use aeron_rs::aeron::Aeron;
use aeron_rs::concurrent::atomic_buffer::AtomicBuffer;
use aeron_rs::utils::types::Index;

// =============================================================================
// WIRE FORMAT
// =============================================================================

/// Replication channel — must match REPLICATION_CHANNEL in main.rs exactly.
const REPLICATION_CHANNEL: &str = "aeron:udp?endpoint=127.0.0.1:40124";

/// Replication stream ID — must match REPLICATION_STREAM_ID in main.rs exactly.
const REPLICATION_STREAM_ID: i32 = 1002;

/// Aeron media driver shared-memory directory.
const AERON_DIR: &str = "/dev/shm/aeron";

/// Maximum fragments processed per poll call.
const FRAGMENT_LIMIT: i32 = 64;

/// Wire frame size in bytes. Must match ENVELOPE_SIZE in envelope.rs.
const ENVELOPE_SIZE: usize = 512;

/// Wire layout of a replicated transaction frame (matches envelope.rs #[repr(C)]):
///
///   [0:32]    intent_hash   [u8; 32]
///   [32:96]   signature     [u8; 64]
///   [96:100]  sender        u32 LE
///   [100:104] receiver      u32 LE
///   [104:112] amount        u64 LE
///   [112:120] nonce         u64 LE
///   [120]     action        u8
///   [121:512] _padding      [u8; 391]
///
/// The follower reads fields via explicit byte-offset unaligned reads —
/// the same technique as process_envelope in main.rs — so changes to
/// this struct do not affect mutation correctness as long as the offsets
/// below are kept synchronised with the primary node's packing code.
#[repr(C)]
struct TransactionEnvelope {
    _raw: [u8; ENVELOPE_SIZE],
}

// Compile-time assertion: wire frame size must be exactly 512 bytes.
// If envelope.rs changes ENVELOPE_SIZE this will fail at compile time,
// not silently corrupt the follower's ledger at runtime.
const _: () = assert!(mem::size_of::<TransactionEnvelope>() == ENVELOPE_SIZE);

impl Default for TransactionEnvelope {
    fn default() -> Self {
        Self { _raw: [0u8; ENVELOPE_SIZE] }
    }
}

// =============================================================================
// LEDGER
// =============================================================================

/// Account balance cell — 64-byte cache-line aligned to match the primary node.
/// Alignment prevents false sharing if the follower is later made multi-threaded.
#[repr(C, align(64))]
struct Account {
    balance: i64,
    _pad: [u8; 56],
}

const ACCOUNT_COUNT:         usize = 100_000;
const INITIAL_BALANCE_TIYIN: i64   = 100_000_000;

struct Ledger {
    accounts: Vec<Account>,
    /// Running count of successfully mirrored transactions for telemetry.
    total_mirrored: u64,
}

impl Ledger {
    fn new() -> Self {
        let mut accounts: Vec<Account> = (0..ACCOUNT_COUNT)
            .map(|_| Account { balance: INITIAL_BALANCE_TIYIN, _pad: [0u8; 56] })
            .collect();

        // Mirror the primary node's System Mint initialisation exactly.
        // Account 0 funds all injection operations on the primary.
        if !accounts.is_empty() {
            accounts[0].balance = 1_000_000_000_000_000_000;
        }

        Ledger { accounts, total_mirrored: 0 }
    }

    /// Mutate the follower ledger from a raw 512-byte frame received over Aeron.
    ///
    /// Uses identical byte offsets and unaligned-read logic as `process_envelope`
    /// in `main.rs`. The base pointer is the start of the frame, not a `payload`
    /// sub-field — `env as *const _ as *const u8` is the canonical cast pattern
    /// established in main.rs during the C-ABI alignment debugging sprint.
    ///
    /// No ACK channel. The follower is a pure state mirror; it never sends
    /// return traffic to the Go gateway.
    #[inline(always)]
    fn process_envelope(&mut self, raw_frame: &[u8; ENVELOPE_SIZE]) {
        // Absolute base pointer of the 512-byte frame.
        let p = raw_frame.as_ptr();

        // ── FIELD EXTRACTION (HFT byte-offset reads) ──────────────────────
        //
        // Wire layout offsets (confirmed against Go ipc.PackEnvelope and
        // the last successful mutation sprint on the primary node):
        //
        //   [0:32]    intent_hash  (skip — follower does not ACK)
        //   [32:96]   signature    (skip — follower trusts primary's vault)
        //   [96:100]  sender       u32 LE
        //   [100:104] receiver     u32 LE
        //   [104:112] amount       u64 LE
        //
        // SAFETY: raw_frame is [u8; ENVELOPE_SIZE] (512 bytes). All offsets
        // are within bounds (max read end = 112 < 512). read_unaligned is
        // mandatory because the frame base carries only u8 alignment.

        let s = unsafe {
            std::ptr::read_unaligned(p.add(104) as *const u32)
                } as usize;

        let r = unsafe {
            std::ptr::read_unaligned(p.add(108) as *const u32)
                } as usize;

        let a = unsafe {
            std::ptr::read_unaligned(p.add(112) as *const u64)
                } as i64;

        // ── GATE: INVALID ROUTING ─────────────────────────────────────────
        if s == r || s >= self.accounts.len() || r >= self.accounts.len() {
            eprintln!(
                "[FOLLOWER] ⚠️  SKIP: Invalid routing (s={}, r={}, len={})",
                s, r, self.accounts.len()
            );
            return;
        }

        // ── GATE: INVALID AMOUNT ──────────────────────────────────────────
        if a <= 0 {
            eprintln!("[FOLLOWER] ⚠️  SKIP: Amount is zero or negative ({})", a);
            return;
        }

        // ── GATE: INSUFFICIENT FUNDS ──────────────────────────────────────
        //
        // The follower mirrors the primary's state, so a frame that passed the
        // primary's vault should always have sufficient funds here. If this
        // fires, the follower's ledger has drifted — log it clearly.
        if self.accounts[s].balance < a {
            eprintln!(
                "[FOLLOWER] ❌ STATE DRIFT: Insufficient funds on follower \
                 (acct {} has {} but frame demands {}). \
                 Primary/follower ledgers are out of sync.",
                s, self.accounts[s].balance, a
            );
            return;
        }

        // ── MUTATE THE MIRROR ─────────────────────────────────────────────
        self.accounts[s].balance -= a;
        self.accounts[r].balance = self.accounts[r].balance.saturating_add(a);
        self.total_mirrored += 1;

        println!(
            "[FOLLOWER] 🇪🇺 EU Node Mirrored -> Sender: {}, Receiver: {}, \
             Amount: {} | Acct {} Bal: {}",
            s, r, a,
            s, self.accounts[s].balance,
        );
    }
}

// =============================================================================
// BACKOFF IDLE STRATEGY
// =============================================================================
//
// The follower is a secondary node — a full BusySpinIdle would waste an entire
// CPU core waiting for replication traffic that arrives at the primary's TPS,
// not at line rate. Three-phase backoff matches the WalIdle pattern in main.rs.

struct FollowerIdle {
    spin:   u32,
    yield_: u32,
    phase:  u8,
}

impl FollowerIdle {
    fn new() -> Self {
        FollowerIdle { spin: 0, yield_: 0, phase: 0 }
    }

    fn idle(&mut self) {
        match self.phase {
            0 => {
                std::hint::spin_loop();
                self.spin += 1;
                if self.spin >= 100 { self.phase = 1; self.spin = 0; }
            }
            1 => {
                std::thread::yield_now();
                self.yield_ += 1;
                if self.yield_ >= 100 { self.phase = 2; self.yield_ = 0; }
            }
            _ => {
                std::thread::sleep(Duration::from_micros(1));
            }
        }
    }

    #[inline(always)]
    fn reset(&mut self) {
        self.spin   = 0;
        self.yield_ = 0;
        self.phase  = 0;
    }
}

// =============================================================================
// MAIN
// =============================================================================

fn main() {
    println!("[FOLLOWER] ═══════════════════════════════════════════════════════");
    println!("[FOLLOWER] REVENANT EU Node — Cross-Region Follower");
    println!("[FOLLOWER] Subscribing: {} stream {}", REPLICATION_CHANNEL, REPLICATION_STREAM_ID);
    println!("[FOLLOWER] Accounts: {} | Initial balance: {} tiyin each",
             ACCOUNT_COUNT, INITIAL_BALANCE_TIYIN);
    println!("[FOLLOWER] ─────────────────────────────────────────────────────");

    // ── LEDGER INIT ───────────────────────────────────────────────────────
    let mut ledger = Ledger::new();
    println!("[FOLLOWER] Ledger initialised. Account[0] (System Mint) = {} tiyin.",
             ledger.accounts[0].balance);

    // ── AERON CONNECT ─────────────────────────────────────────────────────
    //
    // AERON_DIR must be set before Aeron::connect() is called.
    // The media driver reads this env var to locate its shared-memory IPC files.
    // Must match the primary node's AERON_DIR (/dev/shm/aeron).
    std::env::set_var("AERON_DIR", AERON_DIR);

    println!("[FOLLOWER] Connecting to Aeron Media Driver at {}", AERON_DIR);

    let mut aeron = loop {
        match Aeron::connect() {
            Ok(a) => break a,
            Err(e) => {
                println!("[FOLLOWER] Media Driver not ready ({:?}). Retrying in 1s...", e);
                std::thread::sleep(Duration::from_secs(1));
            }
        }
    };

    println!("[FOLLOWER] Aeron connected.");

    // ── ADD SUBSCRIPTION ──────────────────────────────────────────────────
    //
    // CString is required by aeron-rs 0.1.8 add_subscription().
    let channel = CString::new(REPLICATION_CHANNEL)
        .expect("[FOLLOWER] FATAL: REPLICATION_CHANNEL contains null byte");

    let subscription_id = aeron
        .add_subscription(channel, REPLICATION_STREAM_ID)
        .expect("[FOLLOWER] FATAL: add_subscription failed");

    println!(
        "[FOLLOWER] Subscription requested (id={}). Waiting for media driver...",
        subscription_id
    );

    // ── FIND SUBSCRIPTION ─────────────────────────────────────────────────
    //
    // find_subscription returns Result<Arc<Mutex<Subscription>>, _> in 0.1.8.
    // Spin-yield until the media driver confirms the subscription is live.
    let subscription = loop {
        if let Ok(sub) = aeron.find_subscription(subscription_id) {
            break sub;
        }
        std::thread::yield_now();
    };

    println!(
        "[FOLLOWER] Subscription LIVE on stream {}. \
         Waiting for primary node replication frames...",
        REPLICATION_STREAM_ID
    );

    // ── FRAGMENT HANDLER ──────────────────────────────────────────────────
    //
    // The closure captures `ledger` via a raw mutable pointer. This is the
    // same pattern used in network_rx.rs to capture `disruptor_ptr` and
    // `next_seq_ptr`. It is required because the closure's lifetime (it lives
    // across the entire poll loop) cannot hold a `&mut Ledger` borrow while
    // the loop body also holds a borrow through `subscription.lock()`.
    //
    // SAFETY: The follower is single-threaded. `ledger` lives for the entire
    // duration of the poll loop. The closure is the sole accessor of ledger
    // during its lifetime — no concurrent access is possible.
    let ledger_ptr: *mut Ledger = &mut ledger;

    let mut fragment_handler = move |buffer: &AtomicBuffer,
                                     offset: Index,
                                     length: Index,
                                     _header: &_| {
        // ── FRAME SIZE GATE ───────────────────────────────────────────────
        //
        // Every valid replication frame is exactly ENVELOPE_SIZE bytes.
        // Malformed frames (wrong size) are silently dropped — they cannot
        // be a valid TransactionEnvelope from the primary node.
        if length as usize != ENVELOPE_SIZE {
            eprintln!(
                "[FOLLOWER] ⚠️  SKIP: Bad frame size {} (expected {})",
                length, ENVELOPE_SIZE
            );
            return;
        }

        // ── COPY FRAME TO STACK ───────────────────────────────────────────
        //
        // buffer.get_bytes copies `ENVELOPE_SIZE` bytes from the Aeron term
        // buffer (shared memory) into a local stack array. This is a single
        // memcpy, identical to the pattern in network_rx.rs. The stack array
        // has no alignment constraint beyond u8, which is why all subsequent
        // field reads use read_unaligned.
        let mut raw_frame = [0u8; ENVELOPE_SIZE];
        buffer.get_bytes(offset, &mut raw_frame);

        // ── MUTATE FOLLOWER LEDGER ────────────────────────────────────────
        //
        // SAFETY: ledger_ptr points to `ledger` in main(). The follower is
        // single-threaded; this closure is the only code that dereferences it.
        // The raw pointer pattern is required to satisfy the borrow checker
        // with a `move` closure that outlives a single loop iteration.
        let ledger = unsafe { &mut *ledger_ptr };
        ledger.process_envelope(&raw_frame);
    };

    // ── POLL LOOP ─────────────────────────────────────────────────────────
    //
    // Drives the fragment handler. Identical structure to the poll loop in
    // network_rx.rs. The subscription is Arc<Mutex<Subscription>> in
    // aeron-rs 0.1.8 — lock per poll call is the required API.
    let mut idle = FollowerIdle::new();

    loop {
        let fragments_read = subscription
           .lock()
           .unwrap()
           .poll(&mut fragment_handler, FRAGMENT_LIMIT); // Removed .unwrap_or(0)

            if fragments_read > 0 {
                idle.reset();
            } else {
                idle.idle();
            }
        }
}