use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::os::unix::fs::FileExt; // Grants pread (read_exact_at)
use std::fs::File;
use std::sync::Arc;

// Assuming imports from previous sprints
// use crate::consensus::{SequencedEnvelope, ClusterState};
// use crate::mutator::Ledger;

const ENVELOPE_SIZE: usize = 512;
const REPLAY_BATCH_SIZE: usize = 64; // Send 64 envelopes per TCP frame

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct ReplayRequest {
pub node_id: u8,
pub requested_start_seq: u64,
pub requested_end_seq: u64,
}

/// A highly optimized map keeping track of where sequences live on disk.
/// E.g., pushed to this vector every time the WAL completes a 4MB chunk.
pub struct SparseIndex {
// (Sequence_ID, WAL_Byte_Offset)
pub checkpoints: Vec<(u64, u64)>,
}

impl SparseIndex {
/// Binary search to find the closest byte offset that is <= the requested sequence.
pub fn find_nearest_offset(&self, target_seq: u64) -> u64 {
let idx = self.checkpoints.partition_point(|&(seq, _)| seq <= target_seq);
if idx == 0 {
return 0; // Start of file
}
self.checkpoints[idx - 1].1
}
}

// =========================================================================
// THE LEADER LOGIC (Dedicated Background TCP Thread)
// =========================================================================

pub struct ReplayServer {
wal_file: Arc<File>,
sparse_index: Arc<SparseIndex>,
}

impl ReplayServer {
pub fn new(wal_file: Arc<File>, sparse_index: Arc<SparseIndex>) -> Self {
Self { wal_file, sparse_index }
}

/// Handles an incoming NAK over a reliable TCP side-channel.
/// Uses pread (read_exact_at) so it does not mutate the File's global cursor,
/// allowing multiple followers to replay concurrently without locking.
pub fn handle_client(&self, mut stream: TcpStream) -> Result<(), std::io::Error> {
let mut req_buf = [0u8; std::mem::size_of::<ReplayRequest>()];
stream.read_exact(&mut req_buf)?;

let req = unsafe { &*(req_buf.as_ptr() as *const ReplayRequest) };

let mut current_offset = self.sparse_index.find_nearest_offset(req.requested_start_seq);
let mut env_buf = [0u8; ENVELOPE_SIZE];
let mut found_start = false;
let mut sent_count = 0;

let target_count = req.requested_end_seq - req.requested_start_seq + 1;

// Scan the WAL
while sent_count < target_count {
match self.wal_file.read_exact_at(&mut env_buf, current_offset) {
Ok(_) => {
current_offset += ENVELOPE_SIZE as u64;

let env = unsafe { &*(env_buf.as_ptr() as *const SequencedEnvelope) };

// Skip Sprint 6 Empty Envelope Padding
if env.sequence_id == 0 {
continue;
}

// Fast-forward to the requested start sequence
if !found_start {
if env.sequence_id < req.requested_start_seq {
continue;
} else if env.sequence_id == req.requested_start_seq {
found_start = true;
} else {
// The WAL is corrupted or the sequence was compacted/snapshotted away
return Err(std::io::Error::new(
std::io::ErrorKind::NotFound,
"Requested sequence dropped by Snapshot Engine",
));
}
}

// We are in the requested range. Blast it over TCP.
stream.write_all(&env_buf)?;
sent_count += 1;

if env.sequence_id == req.requested_end_seq {
break;
}
}
Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
// We hit the end of the WAL before fulfilling the request.
break;
}
Err(e) => return Err(e),
}
}

stream.flush()?;
Ok(())
}
}

// =========================================================================
// THE FOLLOWER LOGIC (Catch-up Mode)
// =========================================================================

pub struct ReplayClient {
leader_tcp_addr: String,
node_id: u8,
}

impl ReplayClient {
/// Called when the Follower detects a gap in the UDP stream.
/// Blocks the Follower's local progression until the gap is healed,
/// but the Follower will buffer incoming UDP multicast frames in memory meanwhile.
pub fn execute_catchup(
&self,
start_seq: u64,
end_seq: u64,
state: &mut crate::consensus::ClusterState,
// disruptor: &mut Disruptor
) -> Result<(), std::io::Error> {

let mut stream = TcpStream::connect(&self.leader_tcp_addr)?;

let req = ReplayRequest {
node_id: self.node_id,
requested_start_seq: start_seq,
requested_end_seq: end_seq,
};

let req_bytes = unsafe {
std::slice::from_raw_parts(
(&req as *const ReplayRequest) as *const u8,
std::mem::size_of::<ReplayRequest>(),
)
};
stream.write_all(req_bytes)?;

let mut env_buf = [0u8; ENVELOPE_SIZE];
let mut expected_seq = start_seq;

while expected_seq <= end_seq {
stream.read_exact(&mut env_buf)?;
let env = unsafe { *(env_buf.as_ptr() as *const SequencedEnvelope) };

// STRICT MONOTONICITY GATE
if env.sequence_id != expected_seq {
panic!("FATAL: Leader served non-contiguous replay block. Expected {}, got {}", expected_seq, env.sequence_id);
}

// -> AT THIS POINT:
// 1. We mathematically pump this frame into the Follower's local LMAX Disruptor.
// disruptor.publish(&env);

// 2. Advance the Follower's commit index.
state.commit_index = env.sequence_id;
expected_seq += 1;
}

Ok(())
}
}