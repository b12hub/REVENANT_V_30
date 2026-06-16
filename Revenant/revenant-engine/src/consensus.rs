use std::sync::atomic::{AtomicU64, Ordering};
use std::mem;

// Assuming imports from previous sprints:
// use crate::network_rx::TransactionEnvelope;
// use crate::mutator::Ledger;

const MAX_IN_FLIGHT: usize = 1024; // Must be a power of 2 for bitwise masking
const IN_FLIGHT_MASK: u64 = (MAX_IN_FLIGHT as u64) - 1;

#[derive(Debug, PartialEq, Clone, Copy)]
pub enum NodeRole {
    Leader,
    Follower,
    Candidate,
}

/// Raft-style payload header
#[repr(C)]
#[derive(Clone, Copy)]
pub struct SequencedEnvelope {
    pub term: u64,
    pub sequence_id: u64,
    // Note: We embed the original 512-byte payload here
    // pub payload: TransactionEnvelope,
    pub payload_hash: [u8; 32], // Simplified for demonstration
}

/// The Zero-Allocation In-Flight Buffer.
/// Tracks envelopes that have been multicast but lack Quorum.
struct InFlightEntry {
    envelope: Option<SequencedEnvelope>,
    acks: u8,
}

pub struct ClusterState {
    pub role: NodeRole,
    pub current_term: u64,
    pub commit_index: u64,
    pub last_applied: u64,

    // Leader sequence tracker
    pub next_sequence_id: u64,

    // Ring buffer for uncommitted leader proposals
    in_flight: [InFlightEntry; MAX_IN_FLIGHT],
}

impl ClusterState {
    pub fn new(role: NodeRole) -> Self {
        // Initialize the array without heap allocation
        const EMPTY_ENTRY: InFlightEntry = InFlightEntry { envelope: None, acks: 0 };

        Self {
            role,
            current_term: 1,
            commit_index: 0,
            last_applied: 0,
            next_sequence_id: 1,
            in_flight: [EMPTY_ENTRY; MAX_IN_FLIGHT],
        }
    }

    // =========================================================================
    // LEADER LOGIC: The Non-Blocking Sequencer
    // =========================================================================

    /// Called by the Leader when a valid intent crosses the IPC bridge.
    /// Executes in nanoseconds. Does NOT wait for network.
    #[inline(always)]
    pub fn append_as_leader(&mut self, env: SequencedEnvelope) -> Result<u64, &'static str> {
        if self.role != NodeRole::Leader {
            return Err("REJECT: Not the Leader. Redirect to Tashkent primary.");
        }

        let seq_id = self.next_sequence_id;

        // Prevent ring buffer overflow if network to Samarkand/Fergana is dead
        if seq_id - self.commit_index > MAX_IN_FLIGHT as u64 {
            return Err("REJECT: In-flight buffer full. Cluster is experiencing backpressure.");
        }

        // Slot into the ring buffer using bitwise masking (faster than modulo)
        let idx = (seq_id & IN_FLIGHT_MASK) as usize;

        let mut sequenced_env = env;
        sequenced_env.sequence_id = seq_id;
        sequenced_env.term = self.current_term;

        // Leader intrinsically votes for its own proposal
        self.in_flight[idx] = InFlightEntry {
            envelope: Some(sequenced_env),
            acks: 1,
        };

        self.next_sequence_id += 1;

        // -> AT THIS POINT: The Aeron Egress thread multicasts the sequenced_env
        // to Samarkand and Fergana.

        Ok(seq_id)
    }

    /// Called by the background Network RX thread when an ACK arrives from a Replica.
    #[inline(always)]
    pub fn handle_replica_ack(&mut self, seq_id: u64, term: u64) /* -> Option<Vec<SequencedEnvelope>> */ {
        if self.role != NodeRole::Leader || term < self.current_term {
            return; // Stale ACK or role changed
        }

        if seq_id <= self.commit_index || seq_id >= self.next_sequence_id {
            return; // Already committed or out of bounds
        }

        let idx = (seq_id & IN_FLIGHT_MASK) as usize;
        self.in_flight[idx].acks += 1;

        // QUORUM ACHIEVED: Leader (1) + Replica (1) = 2 out of 3.
        if self.in_flight[idx].acks >= 2 {
            // We can only commit sequentially. We iterate from commit_index + 1 to check
            // if we have a contiguous block of Quorum-approved envelopes.
            while self.commit_index + 1 < self.next_sequence_id {
                let check_idx = ((self.commit_index + 1) & IN_FLIGHT_MASK) as usize;

                if self.in_flight[check_idx].acks >= 2 {
                    self.commit_index += 1;

                    // The envelope is mathematically committed.
                    // Extract it, clear the slot, and push to the LMAX mutator.
                    if let Some(committed_env) = self.in_flight[check_idx].envelope.take() {
                        // -> AT THIS POINT: Push committed_env to the local LMAX Disruptor.
                        // e.g., self.lmax_disruptor.publish(committed_env.payload);
                    }
                } else {
                    break; // Gap in sequential commits; wait for delayed ACKs.
                }
            }
        }
    }

    // =========================================================================
    // FOLLOWER LOGIC: The Deterministic Replica
    // =========================================================================

    /// Called by a Replica when a multicast frame arrives from the Leader.
    #[inline(always)]
    pub fn append_as_follower(&mut self, env: SequencedEnvelope) -> Result<(), &'static str> {
        if self.role == NodeRole::Leader {
            return Err("REJECT: Leader received a peer multicast.");
        }

        if env.term < self.current_term {
            return Err("REJECT: Stale term.");
        }

        // Update term if Leader has advanced
        if env.term > self.current_term {
            self.current_term = env.term;
            // self.role = NodeRole::Follower; (If Candidate)
        }

        // The Strict Monotonicity Gate
        if env.sequence_id == self.commit_index + 1 {
            // Perfect sequential continuity.
            self.commit_index += 1;

            // -> AT THIS POINT:
            // 1. Send ACK(seq_id) back to Leader over Aeron UDP.
            // 2. Push to local LMAX Disruptor for identical state mutation.

            Ok(())
        } else if env.sequence_id <= self.commit_index {
            // Replay of an already committed frame (network duplicate). Drop it safely.
            Ok(())
        } else {
            // GAP DETECTED. Network packet loss.
            // env.sequence_id > self.commit_index + 1

            // -> AT THIS POINT:
            // Multicast NAK / Replay Request back to Leader
            // requesting frames [self.commit_index + 1 .. env.sequence_id]
            Err("GAP DETECTED: Dropping frame and triggering NAK/Replay protocol.")
        }
    }
}