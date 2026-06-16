use std::time::{Duration, Instant};

// Assuming imports from previous sprints
// use crate::consensus::{NodeRole, ClusterState};

const MIN_ELECTION_TIMEOUT_MS: u32 = 150;
const MAX_ELECTION_TIMEOUT_MS: u32 = 300;

/// Zero-allocation, lock-free PRNG for sub-nanosecond jitter generation.
struct XorShift32 {
    state: u32,
}

impl XorShift32 {
    fn new(seed: u32) -> Self {
        // Seed cannot be zero
        Self { state: if seed == 0 { 1 } else { seed } }
    }

    #[inline(always)]
    fn next(&mut self) -> u32 {
        let mut x = self.state;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.state = x;
        x
    }

    #[inline(always)]
    fn random_timeout(&mut self) -> Duration {
        let range = MAX_ELECTION_TIMEOUT_MS - MIN_ELECTION_TIMEOUT_MS;
        let jitter = self.next() % range;
        Duration::from_millis((MIN_ELECTION_TIMEOUT_MS + jitter) as u64)
    }
}

// =========================================================================
// RAFT IPC MESSAGES (C-ABI Aligned for Aeron UDP)
// =========================================================================

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct RequestVote {
    pub term: u64,
    pub candidate_id: u8,
    pub last_commit_index: u64,
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct VoteResponse {
    pub term: u64,
    pub vote_granted: u8, // 1 for true, 0 for false
}

// =========================================================================
// THE ELECTION STATE MACHINE
// =========================================================================

pub struct ElectionState {
    pub node_id: u8,
    pub role: NodeRole,
    pub current_term: u64,
    pub voted_for_in_term: Option<u8>,

    // Timekeeping
    last_heartbeat: Instant,
    election_timeout: Duration,
    prng: XorShift32,

    // Candidate state
    votes_received: u8,
}

impl ElectionState {
    pub fn new(node_id: u8, seed: u32) -> Self {
        let mut prng = XorShift32::new(seed);
        Self {
            node_id,
            role: NodeRole::Follower, // All nodes boot as Followers
            current_term: 0,
            voted_for_in_term: None,
            last_heartbeat: Instant::now(),
            election_timeout: prng.random_timeout(),
            prng,
            votes_received: 0,
        }
    }

    /// The Hot Loop Tick. Called every millisecond by the network thread.
    #[inline(always)]
    pub fn tick(&mut self, current_commit_index: u64) -> Option<RequestVote> {
        if self.role == NodeRole::Leader {
            // Leaders don't timeout, they send heartbeats (handled in the network egress)
            return None;
        }

        if self.last_heartbeat.elapsed() >= self.election_timeout {
            // SILENCE DETECTED. The Leader is presumed dead.
            return Some(self.trigger_election(current_commit_index));
        }

        None
    }

    fn trigger_election(&mut self, current_commit_index: u64) -> RequestVote {
        self.role = NodeRole::Candidate;
        self.current_term += 1;
        self.voted_for_in_term = Some(self.node_id); // Vote for self
        self.votes_received = 1;

        // Reset the timer with a new random jitter to prevent split-vote deadlocks
        self.last_heartbeat = Instant::now();
        self.election_timeout = self.prng.random_timeout();

        // -> AT THIS POINT: The network layer multicasts this RequestVote
        RequestVote {
            term: self.current_term,
            candidate_id: self.node_id,
            last_commit_index: current_commit_index,
        }
    }

    /// Handles an incoming heartbeat from the Leader
    #[inline(always)]
    pub fn handle_heartbeat(&mut self, leader_term: u64) {
        if leader_term >= self.current_term {
            // Valid heartbeat from a legitimate Leader
            self.role = NodeRole::Follower;
            self.current_term = leader_term;
            self.last_heartbeat = Instant::now();
        }
    }

    /// Evaluates an incoming RequestVote from a Candidate
    pub fn handle_request_vote(&mut self, req: &RequestVote, my_commit_index: u64) -> VoteResponse {
        // RULE 1: Absolute Term Dominance
        if req.term < self.current_term {
            return VoteResponse { term: self.current_term, vote_granted: 0 };
        }

        if req.term > self.current_term {
            // We are behind. Step down to Follower and adopt the new term.
            self.role = NodeRole::Follower;
            self.current_term = req.term;
            self.voted_for_in_term = None;
        }

        // RULE 2: Have we already voted this term?
        let can_vote = match self.voted_for_in_term {
            Some(voted_id) => voted_id == req.candidate_id,
            None => true,
        };

        // RULE 3: Data Integrity Gate (Candidate must be at least as up-to-date as us)
        let is_up_to_date = req.last_commit_index >= my_commit_index;

        if can_vote && is_up_to_date {
            self.voted_for_in_term = Some(req.candidate_id);
            self.last_heartbeat = Instant::now(); // Reset timeout to give candidate time

            VoteResponse { term: self.current_term, vote_granted: 1 }
        } else {
            VoteResponse { term: self.current_term, vote_granted: 0 }
        }
    }

    /// Tallies incoming votes if we are a Candidate
    pub fn handle_vote_response(&mut self, resp: &VoteResponse) -> bool {
        if self.role != NodeRole::Candidate || resp.term != self.current_term {
            return false;
        }

        if resp.vote_granted == 1 {
            self.votes_received += 1;

            // QUORUM ACHIEVED (2 out of 3)
            if self.votes_received >= 2 {
                self.role = NodeRole::Leader;

                // -> AT THIS POINT:
                // 1. Immediately broadcast a Heartbeat to assert dominance.
                // 2. Resume accepting Go IPC envelopes as the new Primary.
                return true;
            }
        }
        false
    }
}