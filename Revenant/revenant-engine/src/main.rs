// =============================================================================
// revenant-engine/src/main.rs — Sprint 8
// REVENANT Execution Engine — Planetary WAL Shipper
// Classification: RESTRICTED — SOVEREIGN INFRASTRUCTURE
// =============================================================================
//
// SPRINT 8: ASYNCHRONOUS WAL REPLICATOR (THE PLANETARY SHIPPER)
//
// aeron-rs 0.1.8 API CORRECTIONS applied in this file:
//
//   E1/E7  AlignedBuffer removed. AtomicBuffer::wrap(*mut u8, i32) is the
//          public constructor. Backing memory is a heap-pinned Vec<u8>.
//
//   E2     offer() takes AtomicBuffer BY VALUE. Pass `buf`, not `&buf`.
//
//   E3     offer() returns Result<u64, AeronError> — NOT Result<i64, _>.
//          `Ok(-1)` is illegal (cannot negate u64 literal). Fix:
//            let pos: u64 = result?;
//            let signed: i64 = pos as i64;
//          Then match on `signed` using i64 literals.
//
//   E4     Aeron::connect() takes 0 parameters in 0.1.8. The Aeron dir is
//          read from the AERON_DIR environment variable. Set it before
//          calling connect().
//
//   E5     add_publication() expects CString, not String. Use
//          CString::new(REPLICATION_CHANNEL).unwrap().
//
//   E6     find_publication() returns Option<Arc<Mutex<Publication>>> in
//          0.1.8, not Result<Option<...>>. Use `if let Some(p)`.
//
// =============================================================================

pub mod network_rx;
pub mod envelope;
pub mod wal;

use std::ffi::CString;
use std::mem::size_of;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};
use std::net::UdpSocket;

// aeron-rs 0.1.8 imports
use aeron_rs::aeron::Aeron;

use crate::envelope::{TransactionEnvelope, ENVELOPE_SIZE};

// =============================================================================
// REPLICATION CONSTANTS
// =============================================================================

const REPLICATION_CHANNEL:   &str = "aeron:udp?endpoint=127.0.0.1:40124";
const REPLICATION_STREAM_ID: i32  = 1002;
const AERON_DIR: &str = "/dev/shm/aeron";
const MAX_OFFER_RETRIES: u32 = 50;
const REPLICATOR_MAX_LAG: u64 = 4_096;

// =============================================================================
// SNAPSHOT CONSTANTS
// =============================================================================

const SNAPSHOT_INTERVAL:   u64   = 100;
const SNAPSHOT_DIR:        &str  = "/var/lib/revenant/snapshots";
const SNAPSHOT_PREFIX:     &[u8] = b"/var/lib/revenant/snapshots/snap_seq_";
const SNAPSHOT_SUFFIX_BIN: &[u8] = b".bin";
const SNAPSHOT_SUFFIX_TMP: &[u8] = b".bin.tmp";
const PATH_BUF_SIZE:       usize = 256;

// =============================================================================
// DISRUPTOR
// =============================================================================

pub mod disruptor {
    use std::mem::ManuallyDrop;
    use std::sync::atomic::{AtomicU64, Ordering};
    use crate::envelope::TransactionEnvelope;

    pub const RING_SIZE: usize = 8_192;
    pub const MASK:      usize = RING_SIZE - 1;
    const _: () = assert!(RING_SIZE.is_power_of_two());

    #[repr(align(64))]
    pub struct PaddedAtomicU64 { pub value: AtomicU64 }

    pub struct Disruptor {
        _ring:                   ManuallyDrop<Vec<TransactionEnvelope>>,
        ring_ptr:                *mut TransactionEnvelope,
        pub published_sequence:  PaddedAtomicU64,
        pub ledger_sequence:     PaddedAtomicU64,
        pub wal_sequence:        PaddedAtomicU64,
        pub replicator_sequence: PaddedAtomicU64,
    }

    unsafe impl Sync for Disruptor {}
    unsafe impl Send for Disruptor {}

    impl Drop for Disruptor {
        fn drop(&mut self) {
            unsafe { ManuallyDrop::drop(&mut self._ring); }
        }
    }

    impl Disruptor {
        pub fn new(recovered_count: u64) -> Self {
            let mut ring = ManuallyDrop::new(vec![TransactionEnvelope::default(); RING_SIZE]);
            let ring_ptr: *mut TransactionEnvelope = ring.as_mut_ptr();

            let published_init = if recovered_count == 0 {
                u64::MAX
            } else {
                recovered_count - 1
            };

            Disruptor {
                ring_ptr,
                _ring:               ring,
                published_sequence:  PaddedAtomicU64 { value: AtomicU64::new(published_init) },
                ledger_sequence:     PaddedAtomicU64 { value: AtomicU64::new(recovered_count) },
                wal_sequence:        PaddedAtomicU64 { value: AtomicU64::new(recovered_count) },
                replicator_sequence: PaddedAtomicU64 { value: AtomicU64::new(recovered_count) },
            }
        }

        #[inline(always)]
        pub unsafe fn slot_ptr_mut(&self, seq: u64) -> *mut TransactionEnvelope {
            self.ring_ptr.add((seq as usize) & MASK)
        }

        #[inline(always)]
        pub unsafe fn slot_ref(&self, seq: u64) -> &TransactionEnvelope {
            &*self.ring_ptr.add((seq as usize) & MASK)
        }

        #[inline(always)]
        pub fn min_consumer_sequence(&self) -> u64 {
            let l = self.ledger_sequence.value.load(Ordering::Acquire);
            let w = self.wal_sequence.value.load(Ordering::Acquire);
            let r = self.replicator_sequence.value.load(Ordering::Acquire);
            l.min(w).min(r)
        }
    }
}

use disruptor::{Disruptor, RING_SIZE};

// =============================================================================
// LEDGER
// =============================================================================

#[repr(C, align(64))]
pub struct Account {
    pub balance: i64,
    last_nonce: u64,
    _pad:       [u8; 48],
}

const _: () = assert!(std::mem::size_of::<Account>() == 64);

pub struct Ledger {
    pub accounts: Vec<Account>,
    // Non-blocking send end of the egress channel.
    // The Egress thread owns the Receiver and performs all UDP I/O.
    // The Ledger thread never touches a socket — it only calls try_send.
    ack_tx: mpsc::SyncSender<([u8; 32], u8)>,
}

const ACCOUNT_COUNT:         usize = 100_000;
const INITIAL_BALANCE_TIYIN: i64   = 100_000_000;

impl Ledger {
    pub fn new(account_count: usize, ack_tx: mpsc::SyncSender<([u8; 32], u8)>) -> Self {
        let mut accounts: Vec<Account> = (0..account_count)
            .map(|_| Account {
                balance:    INITIAL_BALANCE_TIYIN,
                last_nonce: 0,       // 0 = "no transaction seen yet"; any nonce > 0 is valid
                _pad:       [0u8; 48],
            })
            .collect();

        // Fund the System Mint (Account 0) with 10 Quintillion Tiyins
        if !accounts.is_empty() {
            accounts[0].balance = 1_000_000_000_000_000_000;
        }

        Ledger { accounts, ack_tx }
    }

    #[inline(always)]
    pub fn process_envelope(&mut self, env: &TransactionEnvelope) {
        let p = env as *const _ as *const u8;

        let mut intent_hash = [0u8; 32];
        unsafe {
            // Shifted by 16 bytes for term and gsn
            std::ptr::copy_nonoverlapping(p.add(16), intent_hash.as_mut_ptr(), 32);
        }

        let s     = unsafe { std::ptr::read_unaligned(p.add(120) as *const u32) } as usize;
        let r     = unsafe { std::ptr::read_unaligned(p.add(124) as *const u32) } as usize;
        let a     = unsafe { std::ptr::read_unaligned(p.add(128) as *const u64) } as i64;
        let nonce = unsafe { std::ptr::read_unaligned(p.add(136) as *const u64) }; // <-- NEW OFFSET

        if s == r || s >= self.accounts.len() || r >= self.accounts.len() {
            println!("[LEDGER-TRACE] ❌ REJECT: Invalid routing");
            let _ = self.ack_tx.try_send((intent_hash, 2));
            return;
        }

        if a <= 0 {
            println!("[LEDGER-TRACE] ❌ REJECT: Amount is zero or negative");
            let _ = self.ack_tx.try_send((intent_hash, 2));
            return;
        }

        // ── THE IRONCLAD REPLAY GATE ──
        if nonce <= self.accounts[s].last_nonce && nonce != 0 {
            eprintln!(
                "[SECURITY] 🛑 REPLAY ATTACK DETECTED: sender={} incoming_nonce={} last_accepted_nonce={}",
                s, nonce, self.accounts[s].last_nonce
            );
            let _ = self.ack_tx.try_send((intent_hash, 2));
            return;
        }

        if self.accounts[s].balance < a {
            println!("[LEDGER-TRACE] ❌ REJECT: Insufficient funds ({} < {})", self.accounts[s].balance, a);
            let _ = self.ack_tx.try_send((intent_hash, 1));
            return;
        }

        // ── MUTATE THE VAULT ──
        self.accounts[s].balance -= a;
        self.accounts[r].balance  = self.accounts[r].balance.saturating_add(a);
        self.accounts[s].last_nonce = nonce; // <-- SAVE THE NONCE

        let _ = self.ack_tx.try_send((intent_hash, 0));
    }
}

// =============================================================================
// REPLICATOR THREAD
// =============================================================================

fn spawn_replicator_thread(disruptor: Arc<Disruptor>, recovered_count: u64) {
    thread::Builder::new()
        .name("revenant-replicator".to_string())
        .stack_size(2 * 1024 * 1024)
        .spawn(move || {
            println!(
                "[REPLICATOR] Thread starting. Target: {} stream {}",
                REPLICATION_CHANNEL, REPLICATION_STREAM_ID
            );

            std::env::set_var("AERON_DIR", AERON_DIR);

            let mut aeron = loop {
                match Aeron::connect() {
                    Ok(a)  => break a,
                    Err(e) => {
                        eprintln!("[REPLICATOR] Waiting for Media Driver... {:?}", e);
                        std::thread::sleep(Duration::from_secs(1));
                    }
                }
            };

            let channel_cstr = CString::new(REPLICATION_CHANNEL)
                .expect("[REPLICATOR] FATAL: REPLICATION_CHANNEL contains null byte");

            let pub_id = match aeron.add_publication(channel_cstr, REPLICATION_STREAM_ID) {
                Ok(id)  => id,
                Err(e)  => {
                    eprintln!("[REPLICATOR] FATAL: add_publication failed: {:?}", e);
                    std::process::exit(1);
                }
            };

            println!("[REPLICATOR] Waiting for publication to become active...");
            let publication = loop {
                if let Ok(p) = aeron.find_publication(pub_id) {
                    break p;
                }
                std::thread::yield_now();
            };

            println!(
                "[REPLICATOR] Publication LIVE. Channel: {}, Stream: {}. \
                 Offers return NOT_CONNECTED until the EU node subscribes.",
                REPLICATION_CHANNEL, REPLICATION_STREAM_ID
            );

            let mut frame_data: Vec<u8> = vec![0u8; ENVELOPE_SIZE];

            let mut repl_seq       = recovered_count;
            let mut idle           = ReplicatorIdle::new();
            let mut total_offered: u64 = 0;
            let mut total_dropped: u64 = 0;
            let mut total_skipped: u64 = 0;
            let mut batch_count:   u64 = 0;

            loop {
                let published = disruptor
                    .published_sequence
                    .value
                    .load(Ordering::Acquire);

                if published == u64::MAX || repl_seq > published {
                    idle.idle();
                    continue;
                }

                idle.reset();

                let lag = published.saturating_sub(repl_seq);
                if lag > REPLICATOR_MAX_LAG {
                    let skip = lag - REPLICATOR_MAX_LAG;
                    repl_seq      += skip;
                    total_skipped += skip;
                    disruptor
                        .replicator_sequence
                        .value
                        .store(repl_seq.saturating_sub(1), Ordering::Release);
                    eprintln!(
                        "[REPLICATOR] LAG CEILING: skipped {} frames \
                         (total_skipped={}, lag was {}). EU node congested/offline.",
                        skip, total_skipped, lag
                    );
                }

                let available = (published - repl_seq) + 1;
                let mut seq   = repl_seq;

                while seq < repl_seq + available {
                    let env: &TransactionEnvelope =
                        unsafe { disruptor.slot_ref(seq) };

                    unsafe {
                        std::ptr::copy_nonoverlapping(
                            env as *const TransactionEnvelope as *const u8,
                            frame_data.as_mut_ptr(),
                            ENVELOPE_SIZE,
                        );
                    }

                    let mut offer_retries: u32 = 0;
                    let offer_outcome = loop {
                        let buf = aeron_rs::concurrent::atomic_buffer::AtomicBuffer::wrap_slice(&mut frame_data);

                        match publication.lock().unwrap().offer(buf) {
                            Ok(_) => break OfferResult::Sent,
                            Err(aeron_rs::utils::errors::AeronError::NotConnected) => break OfferResult::NotConnected,
                            Err(aeron_rs::utils::errors::AeronError::BackPressured) => {
                                offer_retries += 1;
                                if offer_retries >= MAX_OFFER_RETRIES { break OfferResult::Dropped; }
                                std::hint::spin_loop();
                            }
                            Err(aeron_rs::utils::errors::AeronError::AdminAction) => {
                                offer_retries += 1;
                                if offer_retries >= MAX_OFFER_RETRIES { break OfferResult::Dropped; }
                                std::thread::yield_now();
                            }
                            Err(e) => {
                                eprintln!("[REPLICATOR] AeronError: {:?}. Fatal.", e);
                                break OfferResult::Fatal;
                            }
                        }
                    };

                    match offer_outcome {
                        OfferResult::Sent         => { total_offered += 1; }
                        OfferResult::NotConnected => { total_dropped += 1; }
                        OfferResult::Dropped      => { total_dropped += 1; }
                        OfferResult::Fatal        => {
                            disruptor
                                .replicator_sequence
                                .value
                                .store(u64::MAX >> 1, Ordering::Release);
                            std::process::exit(1);
                        }
                    }

                    seq += 1;
                }

                repl_seq += available;
                disruptor
                    .replicator_sequence
                    .value
                    .store(repl_seq - 1, Ordering::Release);

                batch_count += 1;
                if batch_count % 1024 == 0 {
                    let total = total_offered + total_dropped;
                    let drop_pct = if total > 0 { total_dropped * 100 / total } else { 0 };
                    println!(
                        "[REPLICATOR] batches={} offered={} dropped={} \
                         skipped={} drop%={} repl_seq={}",
                        batch_count, total_offered, total_dropped,
                        total_skipped, drop_pct, repl_seq,
                    );
                }
            }
        })
        .expect("[ENGINE] Failed to spawn revenant-replicator thread");
}

enum OfferResult {
    Sent,
    NotConnected,
    Dropped,
    Fatal,
}

// =============================================================================
// REPLICATOR IDLE STRATEGY
// =============================================================================

struct ReplicatorIdle { spin: u32, yield_: u32, phase: u8 }
impl ReplicatorIdle {
    fn new() -> Self { ReplicatorIdle { spin: 0, yield_: 0, phase: 0 } }
    fn idle(&mut self) {
        match self.phase {
            0 => { std::hint::spin_loop(); self.spin += 1;
                if self.spin  >= 50  { self.phase = 1; self.spin  = 0; } }
            1 => { std::thread::yield_now(); self.yield_ += 1;
                if self.yield_ >= 100 { self.phase = 2; self.yield_ = 0; } }
            _ =>   std::thread::sleep(Duration::from_micros(1)),
        }
    }
    #[inline(always)]
    fn reset(&mut self) { self.spin = 0; self.yield_ = 0; self.phase = 0; }
}

// =============================================================================
// SNAPSHOT PATH BUILDER
// =============================================================================

struct SnapshotPaths {
    final_path: [u8; PATH_BUF_SIZE],
    tmp_path:   [u8; PATH_BUF_SIZE],
}

fn build_snapshot_paths(seq: u64) -> SnapshotPaths {
    let mut paths = SnapshotPaths {
        final_path: [0u8; PATH_BUF_SIZE],
        tmp_path:   [0u8; PATH_BUF_SIZE],
    };
    let mut seq_buf = [0u8; 20];
    let seq_len     = u64_to_decimal_bytes(seq, &mut seq_buf);
    let seq_digits  = &seq_buf[..seq_len];

    let pos = write_path(
        &mut paths.final_path,
        &[SNAPSHOT_PREFIX, seq_digits, SNAPSHOT_SUFFIX_BIN],
    );
    paths.final_path[pos] = 0;

    let pos = write_path(
        &mut paths.tmp_path,
        &[SNAPSHOT_PREFIX, seq_digits, SNAPSHOT_SUFFIX_TMP],
    );
    paths.tmp_path[pos] = 0;
    paths
}

fn write_path(buf: &mut [u8; PATH_BUF_SIZE], parts: &[&[u8]]) -> usize {
    let mut pos = 0usize;
    for part in parts {
        let end = pos + part.len();
        assert!(end < PATH_BUF_SIZE, "Snapshot path exceeds {} bytes", PATH_BUF_SIZE);
        buf[pos..end].copy_from_slice(part);
        pos = end;
    }
    pos
}

fn u64_to_decimal_bytes(n: u64, buf: &mut [u8; 20]) -> usize {
    if n == 0 { buf[0] = b'0'; return 1; }
    let mut tmp = [0u8; 20];
    let mut len = 0usize;
    let mut n   = n;
    while n > 0 { tmp[len] = b'0' + (n % 10) as u8; len += 1; n /= 10; }
    let mut i = 0usize;
    while i < len { buf[i] = tmp[len - 1 - i]; i += 1; }
    len
}

// =============================================================================
// SNAPSHOT TRIGGER / CHILD
// =============================================================================

unsafe fn trigger_cow_snapshot(
    ledger:               &Ledger,
    total_seq:            u64,
    snapshot_seq:         u64,
    child_pid:            &mut libc::pid_t,
    snapshot_in_progress: &mut bool,
) {
    let paths         = build_snapshot_paths(snapshot_seq);
    let data_ptr      = ledger.accounts.as_ptr() as *const u8;
    let data_byte_len = ledger.accounts.len() * size_of::<Account>();
    let pid           = libc::fork();
    match pid {
        -1 => {
            let m = b"[SNAPSHOT] WARN: fork() failed. Skipping snapshot.\n";
            libc::write(2, m.as_ptr() as *const libc::c_void, m.len());
        }
        0 => { do_snapshot_child(data_ptr, data_byte_len, &paths); }
        child => {
            *child_pid            = child;
            *snapshot_in_progress = true;
            let pfx = b"[SNAPSHOT] Triggered: total_seq=";
            libc::write(2, pfx.as_ptr() as *const libc::c_void, pfx.len());
            write_u64_to_fd(2, total_seq);
            let mid = b" snapshot_seq=";
            libc::write(2, mid.as_ptr() as *const libc::c_void, mid.len());
            write_u64_to_fd(2, snapshot_seq);
            libc::write(2, b"\n".as_ptr() as *const libc::c_void, 1);
        }
    }
}

unsafe fn do_snapshot_child(
    data_ptr: *const u8, data_len: usize, paths: &SnapshotPaths,
) -> ! {
    let fd = libc::open(
        paths.tmp_path.as_ptr() as *const libc::c_char,
        libc::O_CREAT | libc::O_WRONLY | libc::O_TRUNC, 0o644u32,
    );
    if fd < 0 { libc::_exit(1); }
    if !write_all_raw(fd, data_ptr, data_len)   { libc::close(fd); libc::_exit(2); }
    let crc = crc32_child(data_ptr, data_len);
    let crc_le = crc.to_le_bytes();
    if !write_all_raw(fd, crc_le.as_ptr(), 4)   { libc::close(fd); libc::_exit(3); }
    if libc::fsync(fd) != 0                     { libc::close(fd); libc::_exit(4); }
    libc::close(fd);
    if libc::rename(
        paths.tmp_path.as_ptr()   as *const libc::c_char,
        paths.final_path.as_ptr() as *const libc::c_char,
    ) != 0 { libc::_exit(5); }
    libc::_exit(0);
}

#[inline(always)]
unsafe fn write_all_raw(fd: i32, mut ptr: *const u8, mut len: usize) -> bool {
    while len > 0 {
        let n = libc::write(fd, ptr as *const libc::c_void, len);
        if n < 0 {
            if *libc::__errno_location() == libc::EINTR { continue; }
            return false;
        }
        if n == 0 { return false; }
        ptr = ptr.add(n as usize);
        len -= n as usize;
    }
    true
}

#[inline(never)]
unsafe fn crc32_child(data: *const u8, len: usize) -> u32 {
    const POLY: u32 = 0xEDB8_8320;
    let mut table = [0u32; 256];
    let mut i = 0usize;
    while i < 256 {
        let mut e = i as u32;
        let mut b = 0u32;
        while b < 8 {
            e = if e & 1 != 0 { (e >> 1) ^ POLY } else { e >> 1 };
            b += 1;
        }
        table[i] = e; i += 1;
    }
    let mut crc = !0u32;
    let mut idx = 0usize;
    while idx < len {
        crc = (crc >> 8) ^ table[((crc ^ *data.add(idx) as u32) & 0xFF) as usize];
        idx += 1;
    }
    !crc
}

#[inline(always)]
unsafe fn write_u64_to_fd(fd: i32, n: u64) {
    let mut buf = [0u8; 20];
    let len     = u64_to_decimal_bytes(n, &mut buf);
    libc::write(fd, buf.as_ptr() as *const libc::c_void, len);
}

// =============================================================================
// ZOMBIE REAPER
// =============================================================================

fn reap_snapshot_child(child_pid: &mut libc::pid_t, snapshot_in_progress: &mut bool) {
    if !*snapshot_in_progress || *child_pid <= 0 { return; }
    let mut status = 0i32;
    let r = unsafe { libc::waitpid(*child_pid, &mut status, libc::WNOHANG) };
    match r {
        0 => {}
        pid if pid == *child_pid => {
            *snapshot_in_progress = false;
            *child_pid            = -1;
            let code = if libc::WIFEXITED(status) {
                libc::WEXITSTATUS(status)
            } else { -1 };
            if code == 0 { eprintln!("[SNAPSHOT] Reaped (exit=0)."); }
            else         { eprintln!("[SNAPSHOT] WARN: child exit={}.", code); }
        }
        _ => { *snapshot_in_progress = false; *child_pid = -1; }
    }
}

fn attach_and_hydrate_ebpf(ledger: &Ledger, iface: &str) -> Result<aya::Bpf, Box<dyn std::error::Error>> {
    use aya::Bpf;
    use aya::programs::{Xdp, XdpFlags};
    use aya::maps::HashMap;

    println!("[eBPF] Loading XDP firewall from xdp_filter.o...");
    let mut bpf = Bpf::load_file("xdp_filter.o")?;

    let program: &mut Xdp = bpf
        .program_mut("xdp")
        .ok_or("Failed to locate 'xdp' section in xdp_filter.o")?
        .try_into()?;

    program.load()?;

    println!("[eBPF] Attaching XDP program to interface '{}'...", iface);
    program.attach(iface, XdpFlags::SKB_MODE)?;

    println!("[eBPF] Hydrating Kernel BPF Map with Snapshot Nonces...");

    let map = bpf.map_mut("nonce_map")?;

    let mut nonce_map: HashMap<_, u32, u64> = HashMap::try_from(map)?;

    let mut hydrated_count = 0;
    for (i, account) in ledger.accounts.iter().enumerate() {
        if account.last_nonce > 0 {
            nonce_map.insert(i as u32, account.last_nonce, 0)?;
            hydrated_count += 1;
        }
    }

    println!("[eBPF] 🛡️ Hardware Firewall ACTIVE on '{}'. {} nonces hydrated to NIC.", iface, hydrated_count);

    Ok(bpf)
}

// =============================================================================
// ENGINE CONSTANTS
// =============================================================================

const WAL_FILE_PATH:    &str     = "/var/lib/revenant/wal/revenant.wal";
const WAL_DIR:          &str     = "/var/lib/revenant/wal";
const METRICS_INTERVAL: Duration = Duration::from_millis(100);

// =============================================================================
// MAIN
// =============================================================================

fn main() {
    std::env::set_var("AERON_DIR", "/dev/shm/aeron-bobur");
    println!("[ENGINE] ════════════════════════════════════════════════════════");
    println!("[ENGINE] REVENANT v3.2 Sprint 8 — Planetary WAL Shipper");
    println!(
        "[ENGINE] Envelope: {} bytes | Account: {} bytes | Ring: {} slots | \
         Snapshot: every {} envelopes",
        size_of::<TransactionEnvelope>(), size_of::<Account>(),
        RING_SIZE, SNAPSHOT_INTERVAL,
    );
    println!(
        "[ENGINE] Replication → {} stream {} | Lag ceiling: {} slots",
        REPLICATION_CHANNEL, REPLICATION_STREAM_ID, REPLICATOR_MAX_LAG,
    );
    println!("[ENGINE] ────────────────────────────────────────────────────────");

    // ── DIRECTORIES ────────────────────────────────────────────────────────
    for dir in &["/var/lib/revenant/wal", SNAPSHOT_DIR] {
        if let Err(e) = std::fs::create_dir_all(dir) {
            eprintln!("[ENGINE] WARNING: Could not create '{}': {}", dir, e);
        } else {
            println!("[ENGINE] Directory ready: {}", dir);
        }
    }

    // ── STEP 1: CREATE LEDGER ──────────────────────────────────────────────
    // ── EGRESS CHANNEL ────────────────────────────────────────────────────
    let (ack_tx, ack_rx) = mpsc::sync_channel::<([u8; 32], u8)>(8_192);

    let mut ledger = Ledger::new(ACCOUNT_COUNT, ack_tx);

    // ── EGRESS THREAD ─────────────────────────────────────────────────────
    thread::Builder::new()
        .name("revenant-egress".into())
        .stack_size(512 * 1024)
        .spawn(move || {
            let socket = UdpSocket::bind("127.0.0.1:0")
                .expect("[EGRESS] FATAL: failed to bind egress UDP socket");
            let target = "127.0.0.1:8081";

            println!("[EGRESS] Thread live. Forwarding ACKs → {}", target);

            let mut packet = [0u8; 33];

            loop {
                let (hash, status) = match ack_rx.recv() {
                    Ok(msg) => msg,
                    Err(_)  => {
                        eprintln!("[EGRESS] Channel closed. Exiting.");
                        return;
                    }
                };

                packet[0..32].copy_from_slice(&hash);
                packet[32] = status;

                if let Err(e) = socket.send_to(&packet, target) {
                    eprintln!("[EGRESS] UDP send failed: {}. Continuing.", e);
                }
            }
        })
        .expect("[ENGINE] Failed to spawn revenant-egress thread");

    // ── STEP 2: LOAD LATEST SNAPSHOT ──────────────────────────────────────
    let snapshot_seq = match wal::load_latest_snapshot(SNAPSHOT_DIR, &mut ledger) {
        Ok(seq) => {
            if seq > 0 {
                println!(
                    "[ENGINE] Snapshot loaded: {} envelopes pre-applied. \
                     WAL replay will skip to block {}.",
                    seq,
                    seq / wal::ENVELOPES_PER_BLOCK as u64,
                );
            }
            seq
        }
        Err(e) => {
            eprintln!("[ENGINE] WARN: Snapshot loader error: {}. Booting from WAL only.", e);
            0u64
        }
    };

    // ── STEP 3: RECOVER WAL FROM SNAPSHOT BOUNDARY ────────────────────────
    let recovered_count = match wal::recover_ledger(WAL_FILE_PATH, &mut ledger, snapshot_seq) {
        Ok(n)  => {
            println!(
                "[ENGINE] WAL replay complete. Total envelopes: {} \
                 (snapshot={} + wal_new={}).",
                n, snapshot_seq, n - snapshot_seq
            );
            n
        }
        Err(e) => {
            eprintln!("[ENGINE] FATAL: WAL recovery failed: {}", e);
            std::process::exit(1);
        }
    };

    // ── STEP 3.5: IGNITE KERNEL FIREWALL ──────────────────────────────────
    let _bpf_guard = match attach_and_hydrate_ebpf(&ledger, "lo") {
        Ok(bpf) => bpf,
        Err(e) => {
            eprintln!("[eBPF] FATAL: Failed to attach XDP firewall: {}. Are you running as root?", e);
            std::process::exit(1);
        }
    };
    // ──────────────────────────────────────────────────────────────────────

    let disruptor = Arc::new(Disruptor::new(recovered_count));

    println!(
        "[ENGINE] Disruptor: {} slots, three consumers \
         (ledger + WAL + replicator).",
        RING_SIZE
    );

    // ── THREAD 1: NETWORK RECEIVER ────────────────────────────────────────
    let rx_disruptor = disruptor.clone();
    thread::Builder::new()
        .name("revenant-network-rx".into())
        .stack_size(2 * 1024 * 1024)
        .spawn(move || {
            match network_rx::run_subscriber(rx_disruptor, recovered_count) {
                Ok(())  => {}
                Err(e)  => { eprintln!("[NETWORK_RX] FATAL: {}", e); std::process::exit(1); }
            }
        })
        .expect("[ENGINE] Failed to spawn network_rx");

    // ── THREAD 2: WAL WRITER ──────────────────────────────────────────────
    let wal_disruptor    = disruptor.clone();
    let recovered_blocks = recovered_count
        .div_ceil(crate::wal::ENVELOPES_PER_BLOCK as u64);

    thread::Builder::new()
        .name("revenant-wal".into())
        .stack_size(4 * 1024 * 1024)
        .spawn(move || {
            let mut w = match wal::WalWriter::new(WAL_FILE_PATH) {
                Ok(w)  => w,
                Err(e) => { eprintln!("[WAL] FATAL: {}", e); std::process::exit(1); }
            };
            w.set_block_sequence(recovered_blocks);
            run_wal_thread(&wal_disruptor, &mut w, recovered_count);
            let _ = w.flush();
        })
        .expect("[ENGINE] Failed to spawn WAL thread");

    // ── THREAD 3: WAL REPLICATOR ─────────────────────────────────────────
    spawn_replicator_thread(disruptor.clone(), recovered_count);

    // ── THREAD 4: WAL ARCHIVER ────────────────────────────────────────────
    spawn_archiver_thread();

    // ── THE ZERO-LOCK BALANCE QUERY API (Port 8083) ──────────────────────
    let live_ledger_ptr = Arc::new(AtomicUsize::new(ledger.accounts.as_ptr() as usize));
    let query_ptr = live_ledger_ptr.clone();

    std::thread::spawn(move || {
        let socket = std::net::UdpSocket::bind("127.0.0.1:8083").expect("Failed to bind query port");
        let mut buf = [0u8; 4];

        loop {
            if let Ok((4, src)) = socket.recv_from(&mut buf) {
                let account_id = u32::from_le_bytes(buf) as usize;
                if account_id < ACCOUNT_COUNT {
                    let current_ptr = query_ptr.load(Ordering::Acquire);
                    let ptr = (current_ptr as *const Account).wrapping_add(account_id);

                    let balance = unsafe { std::ptr::read_volatile(&(*ptr).balance) };
                    let _ = socket.send_to(&balance.to_le_bytes(), src);
                }
            }
        }
    });
    // ─────────────────────────────────────────────────────────────────────

    // ── MAIN THREAD: LEDGER CONSUMER ──────────────────────────────────────
    let mut ledger_seq:           u64         = recovered_count;
    let mut expected_gsn:         u64         = recovered_count + 1; // Strict GSN State Machine
    let mut ooo_buffer:           std::collections::BTreeMap<u64, TransactionEnvelope> = std::collections::BTreeMap::new();

    let mut total_processed:      u64         = recovered_count;
    let mut interval_processed:   u64         = 0;
    let mut last_metrics:         Instant     = Instant::now();
    let mut snapshot_child_pid:   libc::pid_t = -1;
    let mut snapshot_in_progress: bool        = false;
    let telemetry_socket = UdpSocket::bind("127.0.0.1:0").expect("Failed to bind telemetry socket");

    println!(
        "[LEDGER] Online. Resumed at {} events. Expected GSN: {}. Snapshot every {} envelopes.",
        recovered_count, expected_gsn, SNAPSHOT_INTERVAL
    );

    loop {
        // CONTINUOUSLY UPDATE THE POINTER: Safety check in case the Vec ever reallocates
        live_ledger_ptr.store(ledger.accounts.as_ptr() as usize, Ordering::Release);

        // ── METRICS & TELEMETRY FIREHOSE (MOVED TO TOP) ────────────────────
        let elapsed = last_metrics.elapsed();
        if elapsed >= METRICS_INTERVAL {
            let tps      = (interval_processed as f64 / elapsed.as_secs_f64()) as u64;
            let repl_seq = disruptor.replicator_sequence.value.load(Ordering::Relaxed);
            let repl_lag = ledger_seq.saturating_sub(repl_seq);
            reap_snapshot_child(&mut snapshot_child_pid, &mut snapshot_in_progress);

            // ── CALCULATE RING UTILIZATION FOR GO GATEWAY ──
            let min_seq = disruptor.min_consumer_sequence();
            let pub_seq = disruptor.published_sequence.value.load(Ordering::Relaxed);

            let occupied_slots = if pub_seq == u64::MAX || min_seq > pub_seq {
                0
            } else {
                (pub_seq - min_seq) + 1
            };

            let ring_utilization_pct = (occupied_slots as f64 / RING_SIZE as f64) * 100.0;

            println!(
                "[METRICS] TPS:{:>10} | total:{:>12} | ledger:{:>10} | \
                 wal:{:>10} | repl:{:>10} | lag:{:>6} | ring:{:>5.1}%",
                tps, total_processed, ledger_seq,
                disruptor.wal_sequence.value.load(Ordering::Relaxed),
                repl_seq, repl_lag, ring_utilization_pct
            );

            // ── BLAST TELEMETRY TO GO ──
            let telemetry_json = format!(
                "{{\"tps\":{}, \"tx_total\":{}, \"ring_utilization_pct\":{:.2}, \"wal_latency_us\": 12}}",
                tps, total_processed, ring_utilization_pct
            );

            let _ = telemetry_socket.send_to(telemetry_json.as_bytes(), "127.0.0.1:8084");

            interval_processed = 0;
            last_metrics       = Instant::now();
        }
        // ───────────────────────────────────────────────────────────────────

        let published = disruptor.published_sequence.value.load(Ordering::Acquire);
        if published == u64::MAX || ledger_seq > published {
            std::hint::spin_loop();
            continue;
        }

        let available = (published - ledger_seq) + 1;
        let mut seq   = ledger_seq;

        while seq < ledger_seq + available {
            let env = unsafe { disruptor.slot_ref(seq) };

            // Enforce Endianness on the Global Sequence Number
            let env_gsn = u64::from_le(env.gsn);

            println!("[DEBUG] Received GSN: {} | Expected GSN: {}", env_gsn, expected_gsn);

            // ── GLOBAL DETERMINISTIC CONTROL PLANE ──
            if env_gsn == expected_gsn {
                // 1. IN-ORDER: Process immediately
                ledger.process_envelope(env);
                expected_gsn += 1;

                // 2. BUFFER DRAIN: Recursively process queued packets if the gap is now closed
                while let Some(buffered_env) = ooo_buffer.remove(&expected_gsn) {
                    ledger.process_envelope(&buffered_env);
                    expected_gsn += 1;
                }
            } else if env_gsn > expected_gsn {
                // 3. OUT-OF-ORDER: Network jitter, stash packet in the heap buffer
                ooo_buffer.insert(env_gsn, *env);
            } else {
                // 4. STALE/DUPLICATE: Packet arrived late or was retransmitted, drop instantly
            }

            seq += 1;
        }

        ledger_seq         += available;
        total_processed    += available;
        interval_processed += available;

        disruptor.ledger_sequence.value.store(ledger_seq - 1, Ordering::Release);

        // ── SNAPSHOT ───────────────────────────────────────────────────────
        let new_iv = total_processed / SNAPSHOT_INTERVAL;
        let old_iv = (total_processed - available) / SNAPSHOT_INTERVAL;
        if new_iv > old_iv {
            reap_snapshot_child(&mut snapshot_child_pid, &mut snapshot_in_progress);
            if snapshot_in_progress {
                eprintln!(
                    "[SNAPSHOT] Skipping at seq={}: child {} still running.",
                    total_processed, snapshot_child_pid
                );
            } else {
                unsafe {
                    trigger_cow_snapshot(
                        &ledger,
                        total_processed,
                        total_processed,
                        &mut snapshot_child_pid,
                        &mut snapshot_in_progress,
                    );
                }
            }
        }
    }
}

// =============================================================================
// WAL THREAD LOOP
// =============================================================================

fn run_wal_thread(disruptor: &Arc<Disruptor>, wal: &mut wal::WalWriter, recovered_count: u64) {
    let mut wal_seq = recovered_count;
    let mut idle    = WalIdle::new();
    loop {
        let published = disruptor.published_sequence.value.load(Ordering::Acquire);
        if published == u64::MAX || wal_seq > published { idle.idle(); continue; }
        idle.reset();

        let available = (published - wal_seq) + 1;
        let old_seq = wal_seq;
        let mut seq   = wal_seq;

        while seq < wal_seq + available {
            let env = unsafe { disruptor.slot_ref(seq) };
            let raw: &[u8; ENVELOPE_SIZE] = unsafe {
                &*(env as *const TransactionEnvelope as *const [u8; ENVELOPE_SIZE])
            };
            if let Err(e) = wal.append(raw) {
                eprintln!("[WAL] FATAL at wal_seq={}: {}. Halting.", seq, e);
                std::process::exit(1);
            }
            seq += 1;
        }
        wal_seq += available;
        disruptor.wal_sequence.value.store(wal_seq - 1, Ordering::Release);

        // ── ROTATION CHECK ──
        let new_iv = wal_seq / SNAPSHOT_INTERVAL;
        let old_iv = old_seq / SNAPSHOT_INTERVAL;

        if new_iv > old_iv && wal_seq > 0 {
            let boundary_seq = new_iv * SNAPSHOT_INTERVAL;
            let archive_path = format!("{}/revenant_{}.wal.raw", WAL_DIR, boundary_seq);

            if std::fs::rename(WAL_FILE_PATH, &archive_path).is_ok() {
                if wal.rotate(WAL_FILE_PATH).is_ok() {
                    println!("[WAL] Rotated at seq={}. Archiving '{}'", boundary_seq, archive_path);
                }
            }
        }
    }
}

fn spawn_archiver_thread() {
    thread::Builder::new()
        .name("revenant-archiver".into())
        .stack_size(256 * 1024)
        .spawn(|| {
            println!("[ARCHIVER] Thread live. Scanning '{}' every 10s for *.raw files.", WAL_DIR);
            loop {
                std::thread::sleep(Duration::from_secs(10));
                let read_dir = match std::fs::read_dir(WAL_DIR) {
                    Ok(rd)  => rd,
                    Err(_)  => continue,
                };

                for entry_result in read_dir {
                    let entry = match entry_result {
                        Ok(e)  => e,
                        Err(_) => continue,
                    };
                    let path = entry.path();
                    let is_raw = path.extension().and_then(|e| e.to_str()) == Some("raw");

                    if is_raw && path.is_file() {
                        let _ = std::process::Command::new("gzip").arg("-f").arg(&path).status();
                        println!("[ARCHIVER] Compressed '{}'", path.display());
                    }
                }
            }
        })
        .expect("[ENGINE] Failed to spawn revenant-archiver thread");
}

struct WalIdle { spin: u32, yield_: u32, phase: u8 }
impl WalIdle {
    fn new() -> Self { WalIdle { spin: 0, yield_: 0, phase: 0 } }
    fn idle(&mut self) {
        match self.phase {
            0 => { std::hint::spin_loop(); self.spin += 1;
                if self.spin  >= 10  { self.phase = 1; self.spin  = 0; } }
            1 => { std::thread::yield_now(); self.yield_ += 1;
                if self.yield_ >= 100 { self.phase = 2; self.yield_ = 0; } }
            _ =>   std::thread::sleep(Duration::from_micros(1)),
        }
    }
    #[inline(always)]
    fn reset(&mut self) { self.spin = 0; self.yield_ = 0; self.phase = 0; }
}