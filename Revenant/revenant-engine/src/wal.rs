// =============================================================================
// revenant-engine/src/wal.rs
// REVENANT Write-Ahead Log — io_uring Writer + Recovery + Snapshot Bootstrapper
// Classification: RESTRICTED — SOVEREIGN INFRASTRUCTURE
// =============================================================================

use std::ffi::CString;
use std::io::{self, BufReader, Read, Seek, Write , SeekFrom};
use std::mem::size_of;
use std::sync::OnceLock;

use io_uring::{opcode, types, IoUring};

// Assuming TransactionEnvelope is located in your network_rx module
use crate::network_rx::{TransactionEnvelope, ENVELOPE_SIZE};

// =============================================================================
// PUBLIC CONSTANTS
// =============================================================================

pub const BLOCK_SIZE:          usize = 8_192;
pub const ENVELOPES_PER_BLOCK: usize = 15;

const BLOCK_PAYLOAD_SIZE: usize = ENVELOPES_PER_BLOCK * ENVELOPE_SIZE; // 7680
const CRC32_OFFSET:       usize = 8_188;

const _: () = assert!(BLOCK_PAYLOAD_SIZE <= CRC32_OFFSET);
const _: () = assert!(CRC32_OFFSET + 4 == BLOCK_SIZE);

// =============================================================================
// CRC32 — SINGLE CANONICAL IMPLEMENTATION
// =============================================================================

const CRC32_POLY: u32 = 0xEDB8_8320; // IEEE 802.3 / ITU-T V.42

pub fn crc32_of(data: &[u8]) -> u32 {
    static TABLE: OnceLock<[u32; 256]> = OnceLock::new();

    let table = TABLE.get_or_init(|| {
        let mut t = [0u32; 256];
        for i in 0..256_usize {
            let mut e = i as u32;
            for _ in 0..8 {
                e = if e & 1 != 0 { (e >> 1) ^ CRC32_POLY } else { e >> 1 };
            }
            t[i] = e;
        }
        t
    });

    let mut crc: u32 = !0u32;
    for &byte in data {
        crc = (crc >> 8) ^ table[((crc ^ byte as u32) & 0xFF) as usize];
    }
    !crc
}

// =============================================================================
// ALIGNED BUFFER — O_DIRECT backing memory
// =============================================================================

struct AlignedBuffer {
    ptr: *mut u8,
    len: usize,
}

impl AlignedBuffer {
    fn new(len: usize) -> io::Result<Self> {
        unsafe {
            let ptr = libc::mmap(
                std::ptr::null_mut(),
                len,
                libc::PROT_READ | libc::PROT_WRITE,
                libc::MAP_PRIVATE | libc::MAP_ANONYMOUS,
                -1,
                0,
            );
            if ptr == libc::MAP_FAILED {
                return Err(io::Error::last_os_error());
            }
            // mlock pins the pages into physical RAM: no page-fault stall on first write.
            if libc::mlock(ptr, len) != 0 {
                let e = io::Error::last_os_error();
                libc::munmap(ptr, len);
                return Err(e);
            }
            Ok(AlignedBuffer { ptr: ptr as *mut u8, len })
        }
    }

    #[inline(always)]
    fn as_slice_mut(&mut self) -> &mut [u8] {
        unsafe { std::slice::from_raw_parts_mut(self.ptr, self.len) }
    }
}

impl Drop for AlignedBuffer {
    fn drop(&mut self) {
        unsafe { libc::munmap(self.ptr as *mut libc::c_void, self.len); }
    }
}

unsafe impl Send for AlignedBuffer {}

// =============================================================================
// WAL WRITER
// =============================================================================

pub struct WalWriter {
    buffer:    AlignedBuffer,
    ring:      IoUring,
    file_fd:   i32,
    block_seq: u64,
    env_count: usize,
}

impl WalWriter {
    pub fn new(path: &str) -> io::Result<Self> {
        let cstr = CString::new(path).map_err(|_| {
            io::Error::new(io::ErrorKind::InvalidInput, "WAL path contains null byte")
        })?;

        let fd = unsafe {
            libc::open(
                cstr.as_ptr(),
                libc::O_DIRECT | libc::O_SYNC | libc::O_CREAT | libc::O_WRONLY,
                0o644u32,
            )
        };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }

        let file_len = unsafe {
            let mut stat: libc::stat = std::mem::zeroed();
            if libc::fstat(fd, &mut stat) != 0 {
                let e = io::Error::last_os_error();
                libc::close(fd);
                return Err(e);
            }
            stat.st_size as u64
        };
        let block_seq = file_len / BLOCK_SIZE as u64;

        let buffer = AlignedBuffer::new(BLOCK_SIZE).map_err(|e| {
            unsafe { libc::close(fd); }
            e
        })?;
        let ring = IoUring::new(4).map_err(|e| {
            unsafe { libc::close(fd); }
            e
        })?;

        Ok(WalWriter { buffer, ring, file_fd: fd, block_seq, env_count: 0 })
    }

    #[inline]
    pub fn append(&mut self, raw: &[u8; ENVELOPE_SIZE]) -> io::Result<()> {
        let offset = self.env_count * ENVELOPE_SIZE;
        self.buffer.as_slice_mut()[offset..offset + ENVELOPE_SIZE].copy_from_slice(raw);
        self.env_count += 1;
        if self.env_count == ENVELOPES_PER_BLOCK {
            self.flush()?;
        }
        Ok(())
    }

    pub fn flush(&mut self) -> io::Result<()> {
        if self.env_count == 0 {
            return Ok(());
        }

        {
            let block = self.buffer.as_slice_mut();
            let payload_end = self.env_count * ENVELOPE_SIZE;
            block[payload_end..CRC32_OFFSET].fill(0);
            let crc = crc32_of(&block[..CRC32_OFFSET]);
            block[CRC32_OFFSET..BLOCK_SIZE].copy_from_slice(&crc.to_le_bytes());
        }

        let write_op = opcode::Write::new(
            types::Fd(self.file_fd),
            self.buffer.ptr,
            BLOCK_SIZE as u32,
        )
            .offset(self.block_seq * BLOCK_SIZE as u64)
            .build()
            .user_data(self.block_seq);

        unsafe {
            self.ring.submission().push(&write_op).map_err(|_| {
                io::Error::new(io::ErrorKind::Other, "io_uring submission queue full")
            })?;
        }

        self.ring.submit_and_wait(1)?;

        for cqe in self.ring.completion() {
            let r = cqe.result();
            if r < 0 {
                return Err(io::Error::from_raw_os_error(-r));
            }
            if r as usize != BLOCK_SIZE {
                return Err(io::Error::new(
                    io::ErrorKind::WriteZero,
                    format!("io_uring Write: expected {} bytes, got {}", BLOCK_SIZE, r),
                ));
            }
        }

        self.block_seq += 1;
        self.env_count  = 0;
        Ok(())
    }

    pub fn set_block_sequence(&mut self, seq: u64) {
        self.block_seq = seq;
    }

    pub fn rotate(&mut self, new_path: &str) -> io::Result<()> {
        self.flush()?;
        unsafe { libc::close(self.file_fd); }
        self.file_fd = -1;

        let cstr = std::ffi::CString::new(new_path).map_err(|_| {
            io::Error::new(io::ErrorKind::InvalidInput, "WAL rotate path contains null byte")
        })?;

        let new_fd = unsafe {
            libc::open(
                cstr.as_ptr(),
                libc::O_DIRECT | libc::O_SYNC | libc::O_CREAT | libc::O_WRONLY | libc::O_TRUNC,
                0o644u32,
            )
        };

        if new_fd < 0 {
            return Err(io::Error::last_os_error());
        }

        self.file_fd   = new_fd;
        self.block_seq = 0;
        self.env_count = 0;
        Ok(())
    }
}

impl Drop for WalWriter {
    fn drop(&mut self) {
        unsafe { libc::close(self.file_fd); }
    }
}

// =============================================================================
// ALIGNED BLOCK — recovery read buffer
// =============================================================================

#[repr(align(8))]
struct AlignedBlock([u8; BLOCK_SIZE]);

// =============================================================================
// WAL RECOVERY — Merged with Phase F / ICDE Vault logic
// =============================================================================

pub fn recover_ledger(
    path:       &str,
    ledger:     &mut crate::Ledger,
    skip_count: u64,
) -> io::Result<u64> {
    let file = match std::fs::File::open(path) {
        Ok(f)  => f,
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            println!(
                "[WAL-RECOVERY] No WAL file at '{}'. \
                 Using snapshot state alone (seq={}).",
                path, skip_count
            );
            return Ok(skip_count);
        }
        Err(e) => return Err(e),
    };

    let start_block = skip_count / ENVELOPES_PER_BLOCK as u64;
    let skip_within = (skip_count % ENVELOPES_PER_BLOCK as u64) as usize;

    let mut reader = BufReader::with_capacity(64 * 1024, file);

    if start_block > 0 {
        let byte_offset = start_block * BLOCK_SIZE as u64;
        reader.seek(SeekFrom::Start(byte_offset)).map_err(|e| {
            io::Error::new(e.kind(), format!(
                "WAL seek to block {} (byte {}): {}", start_block, byte_offset, e
            ))
        })?;
        println!(
            "[WAL-RECOVERY] Snapshot covers {} envelopes. \
             Seeking to WAL block {} (offset {} bytes). \
             Skipping {} envelopes within that block.",
            skip_count, start_block, byte_offset, skip_within
        );
    }

    let mut total_seq  = skip_count;
    let mut blk_count  = 0u64;
    let mut is_first   = skip_within > 0;

    loop {
        let mut block = AlignedBlock([0u8; BLOCK_SIZE]);

        match reader.read_exact(&mut block.0) {
            Ok(())  => {}
            Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => {
                println!(
                    "[WAL-RECOVERY] End of WAL at block {} (UnexpectedEof). \
                     Replayed {} envelopes on top of snapshot ({} total).",
                    start_block + blk_count,
                    total_seq - skip_count,
                    total_seq,
                );
                break;
            }
            Err(e) => return Err(e),
        }

        // ── CRC VERIFICATION ──────────────────────────────────────────────
        let stored: u32   = u32::from_le_bytes(
            block.0[CRC32_OFFSET..BLOCK_SIZE].try_into().unwrap()
        );
        let computed: u32 = crc32_of(&block.0[..CRC32_OFFSET]);

        if stored != computed {
            println!(
                "[WAL-RECOVERY] CRC mismatch at block {} \
                 (stored=0x{:08X} computed=0x{:08X}). \
                 Torn write boundary — stopping recovery.",
                start_block + blk_count, stored, computed
            );
            break;
        }

        // ── APPLY ENVELOPES ───────────────────────────────────────────────
        let env_start = if is_first { skip_within } else { 0 };
        is_first       = false;

        for i in env_start..ENVELOPES_PER_BLOCK {
            let off = i * ENVELOPE_SIZE;

            let env: &TransactionEnvelope = unsafe {
                &*(block.0.as_ptr().add(off) as *const TransactionEnvelope)
            };

            // NEW SPRINT 6 LOGIC: Skip padding envelopes
            if env.intent_hash == [0; 32] {
                continue;
            }

            // Zero-Copy Cast to bypass module boundary strictness
            let legacy_env = unsafe {
                &*(env as *const _ as *const crate::envelope::TransactionEnvelope)
                };
                ledger.process_envelope(legacy_env);

            total_seq += 1;
        }

        blk_count += 1;
    }

    println!(
        "[WAL-RECOVERY] Complete: snapshot_seq={} + wal_new={} = total_seq={}",
        skip_count,
        total_seq - skip_count,
        total_seq,
    );

    Ok(total_seq)
}

// =============================================================================
// SNAPSHOT BOOTSTRAPPER
// =============================================================================

/// Scans `snapshot_dir` for `snap_seq_<N>.bin` files, loads the one with the
/// highest sequence number whose CRC32 passes, and blasts it directly into the
/// ledger's account array via `copy_nonoverlapping`.
///
/// Returns the sequence number of the loaded snapshot (= number of envelopes
/// already applied to the ledger), so `recover_ledger` knows where to resume
/// WAL replay. Returns `Ok(0)` on cold boot (no directory, no valid files).
///
/// # Snapshot file format (written by `do_snapshot_child` in main.rs)
///
///   [0 .. N*64)     Raw account array bytes  (N = ACCOUNT_COUNT, 64 = size_of::<Account>)
///   [N*64 .. N*64+4) CRC32 of the above, little-endian u32
///
/// # Recovery strategy
///
/// Candidates are sorted descending (newest first). For each candidate:
///   1. Verify file length is exactly `(ACCOUNT_COUNT * 64) + 4`.
///   2. Read the full payload into a temporary heap buffer.
///   3. Compute CRC32 of the payload; compare to the stored trailer.
///   4. If CRC passes: `copy_nonoverlapping` into `ledger.accounts`, return seq.
///   5. If CRC fails: reset ledger to genesis, try the next candidate.
///
/// The temporary buffer ensures the ledger is never mutated on a failed CRC
/// check. The `copy_nonoverlapping` is the single write that commits the state.
pub fn load_latest_snapshot(
    snapshot_dir: &str,
    ledger:       &mut crate::Ledger,
) -> Result<u64, String> {
    // ── DIRECTORY SCAN ────────────────────────────────────────────────────
    let read_dir = match std::fs::read_dir(snapshot_dir) {
        Ok(rd)  => rd,
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            println!("[SNAPSHOT] Directory '{}' not found — cold boot.", snapshot_dir);
            return Ok(0);
        }
        Err(e) => return Err(format!("read_dir('{}'): {}", snapshot_dir, e)),
    };

    // Collect all valid snap_seq_<N>.bin candidates (ignore .tmp and others).
    let mut candidates: Vec<(u64, std::path::PathBuf)> = Vec::new();

    for entry_result in read_dir {
        let entry = match entry_result {
            Ok(e)  => e,
            Err(_) => continue,
        };
        let path = entry.path();
        if !path.is_file() { continue; }

        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(s) => s.to_owned(),
            None    => continue,
        };

        if let Some(seq) = parse_snapshot_seq(&name) {
            candidates.push((seq, path));
        }
    }

    if candidates.is_empty() {
        println!("[SNAPSHOT] No snapshots found in '{}' — cold boot.", snapshot_dir);
        return Ok(0);
    }

    // Descending sort: highest (newest) sequence number first.
    candidates.sort_unstable_by(|a, b| b.0.cmp(&a.0));

    println!(
        "[SNAPSHOT] {} snapshot(s) found. Highest seq={}. Attempting load.",
        candidates.len(),
        candidates[0].0,
    );

    // ── LOAD LOOP ─────────────────────────────────────────────────────────
    for (seq, path) in &candidates {
        match try_load_snapshot(path, ledger) {
            Ok(()) => {
                println!(
                    "[SNAPSHOT] ✓ Loaded snap_seq_{}.bin — {} accounts, CRC OK.",
                    seq, crate::ACCOUNT_COUNT,
                );
                return Ok(*seq);
            }
            Err(e) => {
                eprintln!(
                    "[SNAPSHOT] ✗ snap_seq_{}.bin invalid: {}. \
                     Resetting ledger to genesis and trying next candidate.",
                    seq, e,
                );
                reset_ledger_to_genesis(ledger);
            }
        }
    }

    eprintln!(
        "[SNAPSHOT] All {} snapshot(s) failed CRC or size check. \
         Full WAL replay from genesis.",
        candidates.len(),
    );
    Ok(0)
}

// =============================================================================
// SNAPSHOT INTERNALS
// =============================================================================

/// Parses `snap_seq_<N>.bin` → `Some(N)`. Rejects `.tmp` files and anything
/// with an unexpected format. The `contains('.')` guard rejects multi-extension
/// names like `snap_seq_100.bin.tmp`.
fn parse_snapshot_seq(filename: &str) -> Option<u64> {
    let stem   = filename.strip_prefix("snap_seq_")?;
    let digits = stem.strip_suffix(".bin")?;
    // Reject "snap_seq_100.bin.tmp" — strip_suffix(".bin") would leave "100.bin.tmp"
    // and the digits would contain a dot, which is not a valid integer.
    if digits.contains('.') {
        return None;
    }
    digits.parse::<u64>().ok()
}

/// Attempts to load a single snapshot file into `ledger.accounts`.
///
/// Does NOT mutate `ledger` if the CRC check fails — the temporary buffer is
/// the staging area. `copy_nonoverlapping` is the single commit point.
///
/// # Layout invariants
///
/// `Account` is `#[repr(C, align(64))]` with `{ balance: i64, _pad: [u8;56] }` —
/// exactly 64 bytes. The snapshot writer (`do_snapshot_child`) casts
/// `ledger.accounts.as_ptr() as *const u8` and writes
/// `ACCOUNT_COUNT * size_of::<Account>()` bytes followed by a 4-byte CRC32 LE.
/// We must read with the same geometry.
fn try_load_snapshot(
    path:   &std::path::Path,
    ledger: &mut crate::Ledger,
) -> Result<(), String> {
    // ── SIZE CHECK ────────────────────────────────────────────────────────
    //
    // Reject immediately if the file length is wrong. This avoids reading a
    // partial or corrupted file into the 6.4 MB staging buffer.
    let account_size  = size_of::<crate::Account>();          // 64 bytes
    let data_len      = crate::ACCOUNT_COUNT * account_size;  // 6_400_000 bytes
    let expected_len  = data_len + 4;                         // + 4-byte CRC32 trailer

    let actual_len = std::fs::metadata(path)
        .map_err(|e| format!("stat '{}': {}", path.display(), e))?
        .len() as usize;

    if actual_len != expected_len {
        return Err(format!(
            "wrong size: expected {} ({}×{}+4 CRC), got {}",
            expected_len, crate::ACCOUNT_COUNT, account_size, actual_len,
        ));
    }

    // ── READ INTO STAGING BUFFER ──────────────────────────────────────────
    //
    // One heap allocation of `data_len` bytes. This is a startup operation;
    // it happens at most once (for the first passing candidate).
    // Using `with_capacity` + `set_len` avoids the zero-fill that `resize`
    // would perform — the file read will overwrite every byte immediately.
    //
    // SAFETY: `set_len(data_len)` is valid because `with_capacity(data_len)`
    // guaranteed the allocation. The subsequent `read_exact` will initialise
    // every byte before they are read by `crc32_of` or `copy_nonoverlapping`.
    let mut buf: Vec<u8> = Vec::with_capacity(data_len);
    unsafe { buf.set_len(data_len); }

    let mut file = std::fs::File::open(path)
        .map_err(|e| format!("open '{}': {}", path.display(), e))?;

    file.read_exact(&mut buf)
        .map_err(|e| format!("read {} bytes from '{}': {}", data_len, path.display(), e))?;

    // ── CRC32 VERIFICATION ────────────────────────────────────────────────
    //
    // Compute CRC32 of the staging buffer and compare to the 4-byte LE trailer.
    // This runs before any write to `ledger.accounts` — the ledger is untouched
    // if the check fails.
    let computed: u32 = crc32_of(&buf);

    let mut crc_bytes = [0u8; 4];
    file.read_exact(&mut crc_bytes)
        .map_err(|e| format!("read CRC trailer from '{}': {}", path.display(), e))?;

    let stored: u32 = u32::from_le_bytes(crc_bytes);

    if computed != stored {
        return Err(format!(
            "CRC32 mismatch: file=0x{:08X} computed=0x{:08X}",
            stored, computed,
        ));
    }

    // ── COMMIT: copy_nonoverlapping INTO LEDGER ───────────────────────────
    //
    // CRC passed. Blast the staging buffer directly into the ledger's account
    // array. This is the single write that commits the snapshot to the live
    // ledger state. No further fallibility is possible after this point.
    //
    // SAFETY requirements (all satisfied):
    //   1. `buf.as_ptr()` is valid for `data_len` bytes (confirmed above).
    //   2. `ledger.accounts.as_mut_ptr() as *mut u8` is valid for `data_len`
    //      bytes: `accounts` was allocated with `ACCOUNT_COUNT` elements of
    //      `size_of::<Account>()` bytes each = `data_len` bytes total.
    //   3. Source and destination do not overlap — `buf` is on the heap at a
    //      different address than `ledger.accounts`'s heap allocation.
    //   4. `Account` is `#[repr(C)]` — byte-level copy is well-defined.
    unsafe {
        std::ptr::copy_nonoverlapping(
            buf.as_ptr(),
            ledger.accounts.as_mut_ptr() as *mut u8,
            data_len,
        );
    }

    Ok(())
}

/// Resets all accounts to `INITIAL_BALANCE_TIYIN`, including Account 0.
/// Called when a snapshot candidate fails CRC verification before trying
/// the next candidate. Also re-applies the System Mint funding to Account 0.
fn reset_ledger_to_genesis(ledger: &mut crate::Ledger) {
    for account in &mut ledger.accounts {
        account.balance = crate::INITIAL_BALANCE_TIYIN;
    }
    // Mirror Ledger::new(): Account 0 is the System Mint.
    if !ledger.accounts.is_empty() {
        ledger.accounts[0].balance = 1_000_000_000_000_000_000;
    }
}
