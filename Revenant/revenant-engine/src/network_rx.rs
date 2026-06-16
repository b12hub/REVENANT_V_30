// =============================================================================
// src/network_rx.rs
// REVENANT Execution Engine — Aeron UDP Multicast Subscriber
// =============================================================================
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use std::ffi::CString;
use std::collections::HashSet;

use aeron_rs::aeron::Aeron;
use aeron_rs::concurrent::atomic_buffer::AtomicBuffer;
use aeron_rs::utils::types::Index;

use ed25519_dalek::{VerifyingKey, Signature, Verifier};

use crate::disruptor::{Disruptor, RING_SIZE};
pub(crate) use crate::envelope::{TransactionEnvelope, ENVELOPE_SIZE}; // <-- USE THE OFFICIAL STRUCT

// Preserved user configuration
pub const SUBSCRIPTION_CHANNEL: &str = "aeron:udp?endpoint=127.0.0.1:40123";
pub const STREAM_ID: i32 = 1001;
pub const AERON_DIR: &str = "/dev/shm/aeron-bobur";
pub const FRAGMENT_LIMIT: i32 = 64;

// ─── ZERO-TRUST IPC CONSTANTS ─────────────────────────────────────────
const CLOCK_DRIFT_SUICIDE_NS: u64 = 5_000_000_000; // 5 seconds in nanoseconds

// The ephemeral public key from your Go Orchestrator
const GO_PUBLIC_KEY: [u8; 32] = [3, 138, 224, 15, 18, 254, 157, 147, 216, 121, 41, 32, 199, 13, 11, 5, 125, 251, 24, 102, 203, 228, 250, 172, 138, 251, 228, 225, 24, 77, 197, 216];
static DEBUG_FRAME_COUNTER: AtomicU64 = AtomicU64::new(0);
const PRINT_FIRST_N: u64 = 3;
const PRINT_EVERY_N: u64 = 100_000;

// ─── STRUCT DEFINITIONS ───────────────────────────────────────────────

pub struct IdempotencyGuard {
    seen_nonces: HashSet<u64>,
    seen_intents: HashSet<[u8; 32]>,
}

impl IdempotencyGuard {
    pub fn new(capacity: usize) -> Self {
        Self {
            seen_nonces: HashSet::with_capacity(capacity),
            seen_intents: HashSet::with_capacity(capacity),
        }
    }

    pub fn is_novel(&mut self, nonce: u64, intent: [u8; 32]) -> bool {
        if self.seen_nonces.contains(&nonce) || self.seen_intents.contains(&intent) {
            return false;
        }
        self.seen_nonces.insert(nonce);
        self.seen_intents.insert(intent);
        true
    }
}

// ─── HFT IDLE STRATEGY ────────────────────────────────────────────────

#[derive(Debug)]
enum IdlePhase { Spin, Yield, Park }

pub struct BackoffIdle {
    phase: IdlePhase,
    spin_count: u32,
    yield_count: u32,
}

impl BackoffIdle {
    pub fn new() -> Self {
        BackoffIdle { phase: IdlePhase::Spin, spin_count: 0, yield_count: 0 }
    }
    pub fn idle(&mut self) {
        match self.phase {
            IdlePhase::Spin => {
                std::hint::spin_loop();
                self.spin_count += 1;
                if self.spin_count >= 100 { self.phase = IdlePhase::Yield; self.spin_count = 0; }
            }
            IdlePhase::Yield => {
                std::thread::yield_now();
                self.yield_count += 1;
                if self.yield_count >= 100 { self.phase = IdlePhase::Park; self.yield_count = 0; }
            }
            IdlePhase::Park => {
                std::thread::sleep(Duration::from_micros(1));
            }
        }
    }
    #[inline(always)]
    pub fn reset(&mut self) {
        self.phase = IdlePhase::Spin;
        self.spin_count = 0;
        self.yield_count = 0;
    }
}

// ─── MAIN SUBSCRIBER LOOP ─────────────────────────────────────────────

pub fn run_subscriber(disruptor: Arc<Disruptor>, recovered_count: u64) -> Result<(), String> {
    println!("[NETWORK_RX] Connecting to Aeron Media Driver at {}", AERON_DIR);

    let mut aeron = loop {
        match Aeron::connect() {
            Ok(a) => break a,
            Err(e) => {
                println!("[NETWORK_RX] Waiting for Media Driver... Err: {:?}", e);
                std::thread::sleep(Duration::from_secs(1));
            }
        }
    };

    let channel = CString::new(SUBSCRIPTION_CHANNEL).unwrap();
    let subscription_id = aeron
        .add_subscription(channel, STREAM_ID)
        .map_err(|e| format!("[NETWORK_RX] add_subscription failed: {:?}", e))?;

    println!("[NETWORK_RX] Waiting for subscription to be ready...");

    let subscription;
    loop {
        if let Ok(sub) = aeron.find_subscription(subscription_id) {
            subscription = sub;
            break;
        }
        std::thread::yield_now();
    }

    println!(
        "[NETWORK_RX] Subscription LIVE. ICDE Vault Active.\n\
         [NETWORK_RX] Polling stream {} — will print payload on first {} frames \
         and every {} frames thereafter.",
        STREAM_ID, PRINT_FIRST_N, PRINT_EVERY_N
    );

    let mut idle = BackoffIdle::new();
    let mut next_seq: u64 = recovered_count;

    let mut idempotency_guard = IdempotencyGuard::new(100_000);
    let public_key = VerifyingKey::from_bytes(&GO_PUBLIC_KEY).expect("Invalid hardcoded public key");

    let disruptor_ptr: *const Disruptor = Arc::as_ptr(&disruptor);
    let next_seq_ptr: *mut u64 = &mut next_seq;

    let mut fragment_handler = |buffer: &AtomicBuffer, offset: Index, length: Index, _header: &_| {
        if length as usize != ENVELOPE_SIZE { return; }

        // Securely copy frame into a local aligned stack array
        let mut raw_bytes = [0u8; ENVELOPE_SIZE];
        buffer.get_bytes(offset, &mut raw_bytes);

        // 1. ZERO-COPY CAST
        let envelope = unsafe {
            &*(raw_bytes.as_ptr() as *const TransactionEnvelope)
        };

        // Enforce Endianness from Go IPC
        let timestamp_ns = u64::from_le(envelope.ttl_timestamp);
        let nonce = u64::from_le(envelope.nonce);

        // 2. THE TTL GATE (Clock Drift Suicide Rule)
        let now_ns = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("Time went backwards")
            .as_nanos() as u64;

        if now_ns.saturating_sub(timestamp_ns) > CLOCK_DRIFT_SUICIDE_NS {
            eprintln!("[SECURITY] 🛑 REJECT: TTL Expired (Clock Drift Suicide).");
            return; // Exit the fragment_handler closure, dropping the frame
        }

        // 3. THE IDEMPOTENCY GATE (ICDE Rule)
        if !idempotency_guard.is_novel(nonce, envelope.intent_hash) {
            eprintln!("[SECURITY] 🛑 REJECT: Duplicate Nonce or Intent Hash (Replay Attack).");
            return;
        }

        // 4. THE CRYPTOGRAPHIC GATE
        let sig = Signature::from_bytes(&envelope.signature);
        if public_key.verify_strict(&envelope.intent_hash, &sig).is_err() {
            // Revert cache on forged frame
            idempotency_guard.seen_nonces.remove(&nonce);
            idempotency_guard.seen_intents.remove(&envelope.intent_hash);
            eprintln!("[SECURITY] 🛑 ZERO-TRUST VIOLATION: Invalid Ed25519 signature.");
            return;
        }


        // 5. DISRUPTOR HANDOFF
        let disruptor = unsafe { &*disruptor_ptr };
        let next_seq_val  = unsafe { &mut *next_seq_ptr };

        while next_seq_val.wrapping_sub(disruptor.min_consumer_sequence()) > RING_SIZE as u64 {
            std::hint::spin_loop();
        }

        unsafe {
            let slot_ptr = disruptor.slot_ptr_mut(*next_seq_val);
            let slot_array_ref = &mut *(slot_ptr as *mut [u8; ENVELOPE_SIZE]);
            slot_array_ref.copy_from_slice(&raw_bytes);
        }

        let frame_count = DEBUG_FRAME_COUNTER.fetch_add(1, Ordering::Relaxed);
        let should_print = frame_count < PRINT_FIRST_N || frame_count % PRINT_EVERY_N == 0;

        if should_print {
            println!(
                "[ICDE_VAULT] frame={} | sender_id={} | receiver_id={} | amount={} | nonce={} | valid=true",
                frame_count,
                u32::from_le(envelope.sender),
                u32::from_le(envelope.receiver),
                u64::from_le(envelope.amount),
                nonce
            );
        }

        disruptor.published_sequence.value.store(*next_seq_val, Ordering::Release);
        *next_seq_val = next_seq_val.wrapping_add(1);
    };

    loop {
        let fragments_read = subscription.lock().unwrap()
            .poll(&mut fragment_handler, FRAGMENT_LIMIT);

        if fragments_read > 0 {
            idle.reset();
        } else {
            idle.idle();
        }
    }
}