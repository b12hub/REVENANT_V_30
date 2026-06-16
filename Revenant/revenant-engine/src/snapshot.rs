use libc::{c_void, pid_t};
use std::ffi::CString;
use std::os::unix::io::AsRawFd;
use std::ptr;
use std::sync::atomic::{AtomicU64, Ordering};

// Assuming imports from previous sprints
// use crate::mutator::{Ledger, Account, MAX_ACCOUNTS};
// use crate::wal::WalJournal;

const SNAPSHOT_TEMP_FILE: &str = "ledger.snapshot.tmp\0";
const SNAPSHOT_FINAL_FILE: &str = "ledger.snapshot\0";

pub struct SnapshotEngine {
    last_snapshot_seq: AtomicU64,
}

impl SnapshotEngine {
    pub fn new() -> Self {
        Self {
            last_snapshot_seq: AtomicU64::new(0),
        }
    }

    /// Triggers the BGSAVE-style CoW snapshot.
    /// Returns the child PID so the parent can monitor it via waitpid.
    pub fn trigger_snapshot(&self, current_sequence: u64, ledger: &Ledger) -> Result<pid_t, &'static str> {
        // We flush stdout/stderr before forking so child doesn't duplicate buffered logs
        // (std::io::Write::flush(&mut std::io::stdout()).unwrap();)

        let pid = unsafe { libc::fork() };

        if pid < 0 {
            return Err("FATAL: fork() failed");
        }

        if pid == 0 {
            // ==========================================================
            // CHILD PROCESS: THE GHOST ZONE
            // We are strictly forbidden from allocating heap memory, grabbing
            // Mutexes, or returning from this function (which would trigger Drops).
            // ==========================================================

            unsafe {
                // 1. Open the temp file using raw libc to avoid std::fs machinery
                let file_path = SNAPSHOT_TEMP_FILE.as_ptr() as *const libc::c_char;
                let fd = libc::open(
                    file_path,
                    libc::O_CREAT | libc::O_WRONLY | libc::O_TRUNC,
                    0o644
                );

                if fd < 0 {
                    libc::_exit(1); // Exit silently on failure, bypassing Drop
                }

                // 2. Write the entire pre-allocated array to disk.
                // Because Ledger is a contiguous block of RAM, we can write it in one massive syscall
                // (or loop if it exceeds the OS max write size, typically 2GB).
                let data_ptr = ledger.accounts.as_ptr() as *const c_void;
                let total_bytes = std::mem::size_of::<Account>() * ledger.accounts.len();

                let mut bytes_written = 0;
                while bytes_written < total_bytes {
                    let res = libc::write(
                        fd,
                        data_ptr.add(bytes_written),
                        total_bytes - bytes_written
                    );
                    if res < 0 {
                        libc::close(fd);
                        libc::_exit(1); // I/O Error
                    }
                    bytes_written += res as usize;
                }

                // 3. Atomically rename the temp file to the final snapshot file
                let final_path = SNAPSHOT_FINAL_FILE.as_ptr() as *const libc::c_char;
                libc::rename(file_path, final_path);

                // 4. Close the FD and exit instantly.
                // _exit() prevents Rust from dropping the parent's io_uring FDs.
                libc::close(fd);
                libc::_exit(0);
            }
        }

        // ==========================================================
        // PARENT PROCESS
        // ==========================================================
        self.last_snapshot_seq.store(current_sequence, Ordering::SeqCst);

        // Return the child PID. The parent's background supervisor thread
        // will call `waitpid` on this.
        Ok(pid)
    }

    /// Called by a background supervisor thread to reap the child and rotate WAL.
    pub fn check_child_and_rotate_wal(&self, child_pid: pid_t, wal: &mut crate::wal::WalJournal) {
        let mut status: libc::c_int = 0;

        // WNOHANG ensures the parent doesn't block waiting for the disk I/O
        let res = unsafe { libc::waitpid(child_pid, &mut status, libc::WNOHANG) };

        if res == child_pid {
            if libc::WIFEXITED(status) && libc::WEXITSTATUS(status) == 0 {
                // Snapshot successful. We can safely truncate the WAL up to `last_snapshot_seq`.
                self.rotate_wal(wal);
            } else {
                // Snapshot failed (e.g., out of disk space).
                // We keep the old WAL and try again later.
                eprintln!("CRITICAL: Background snapshot failed.");
            }
        }
    }

    fn rotate_wal(&self, wal: &mut crate::wal::WalJournal) {
        // In a real system:
        // 1. Close the current `wal.fd`.
        // 2. Rename `ledger.wal` to `ledger.wal.archive`.
        // 3. Open a fresh `ledger.wal` with O_DIRECT.
        // 4. (Optional) Delete `ledger.wal.archive`.
    }
}