// =============================================================================
// src/envelope.rs
// REVENANT Execution Engine — Sovereign Envelope (Epic 4)
// =============================================================================

pub const ENVELOPE_SIZE: usize = 512;

#[repr(C)]
#[derive(Clone, Copy)]
pub struct TransactionEnvelope {
    pub term:          u64,        // [0:8]   - EPIC 4: Leader Epoch
    pub gsn:           u64,        // [8:16]  - EPIC 4: Global Sequence Number
    pub intent_hash:   [u8; 32],   // [16:48]
    pub signature:     [u8; 64],   // [48:112]
    pub ttl_timestamp: u64,        // [112:120]
    pub sender:        u32,        // [120:124]
    pub receiver:      u32,        // [124:128]
    pub amount:        u64,        // [128:136]
    pub nonce:         u64,        // [136:144]
    pub action:        u8,         // [144:145]
    pub _padding:      [u8; 367],  // [145:512] Explicit zero-wipe zone
}

// Compile-time guard against alignment drift.
// If anyone adds a field and breaks the 512-byte limit, the engine refuses to compile.
const _: () = assert!(std::mem::size_of::<TransactionEnvelope>() == ENVELOPE_SIZE);

impl Default for TransactionEnvelope {
    fn default() -> Self {
        // Zero-initialize the entire 512-byte cache line
        unsafe { std::mem::zeroed() }
    }
}