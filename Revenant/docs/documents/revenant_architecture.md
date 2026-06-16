# REVENANT — Principal Architect's Breakdown

---

## 1. System Overview & Paradigm

REVENANT is a **Tier-0 Sovereign Event-Sourced Financial Clearing Engine** built for the Uzbekistan banking market. It is not a CRUD microservice. It is an **append-only, deterministic state machine** with a kernel-bypass network front-end.

### The Shift from CRUD to Event-Sourcing

| Traditional CRUD Banking | REVENANT Paradigm |
|---|---|
| SELECT + UPDATE per transaction | Immutable event log (WAL), state derived by replay |
| Synchronous DB round-trip (~5ms) | Sub-microsecond in-memory ledger mutation |
| Locks, MVCC, rollback journals | Lock-free LMAX Disruptor ring buffer |
| TCP/HTTP transport | Aeron UDP multicast IPC |
| Kernel TCP stack processes every byte | eBPF/XDP drops replay attacks at the NIC driver level |

The system is structured as two hard-separated runtimes connected by a **binary ABI over Aeron UDP**:

- **Go Layer** — Ingress, orchestration, AI intent classification, compliance, cryptographic gating.
- **Rust Layer** — Deterministic execution, ledger mutation, WAL persistence, consensus replication.

---

## 2. The Go Ingress & Orchestrator Layer

### 2a. Traffic Entry & Security Perimeter

Traffic enters through the **`cmd/gateway`** binary, which runs a `fasthttp` server (not `net/http`). `fasthttp` reuses `RequestCtx` objects from a pool, avoiding GC pressure on the hot path.

The middleware stack wraps every handler in this order:

```
PoWMiddleware → DeadlineMiddleware → SignatureMiddleware → Router → Handler
```

**`internal/middleware/pow.go`** — Proof-of-Work gate. Every client must present a SHA-256 PoW nonce (`SHA-256(pubkey || nonce)` with leading zero bytes). This is a **Sybil and DDoS resistance mechanism** — it makes flooding the gateway computationally expensive. The ammo generator (`scripts/generate_ammo.go`) pre-mines PoW nonces (`powDifficultyZeroBytes = 2`, meaning the first 2 bytes of SHA-256 must be `0x00`).

**`internal/middleware/signature.go`** — Zero-allocation Ed25519 SEDA Dispatcher. This is architecturally sophisticated: instead of verifying the Ed25519 signature synchronously on the I/O goroutine (which would cause CPU-bound starvation at 100k TPS), the middleware dispatches verification to a **dedicated crypto worker pool** (`internal/crypto/dispatcher.go`). The I/O goroutine parks on a buffered channel, freeing the Go scheduler to serve other connections. `sigBytes [64]byte` and `pubBytes [32]byte` are stack-allocated — the compiler's escape analysis keeps them off the heap.

**`internal/middleware/deadline.go`** — Request deadline enforcement. Drops requests that have exceeded their TTL before they reach the handler.

**`internal/middleware/ratelimit.go`** — Per-client rate limiting.

**`internal/api/sanitizer.go`** — HTTP-level input sanitization before the request body reaches domain logic.

### 2b. Security & Compliance Perimeter

**`internal/firewall/semantic.go`** — The **Phase F Semantic Firewall**. This is the LLM prompt injection defense layer. It implements an 8-stage pipeline in strict order:

1. **Length bounds** — Reject inputs > 2,000 runes before parsing.
2. **Class B (Bidi)** — Hard-reject Unicode bidirectional control chars (CVE-2021-42574 / Trojan Source). These reverse visual text rendering — a human reviewer sees "pay rent" while the LLM tokenizer reads "send to attacker."
3. **Class E (Tag Block)** — Hard-reject U+E0000–U+E007F invisible Unicode tag characters.
4. **Class C strip** — Strip zero-width spaces/joiners to reconstruct the adversary's intended string.
5. **HTML entity decode** — Decode `&#x69;gnore` → `ignore` before phrase matching.
6. **Class D (HTML comment)** — Hard-reject `<!-- hidden instructions -->`.
7. **HTML tag strip** — Remove OCR artifacts from B2B invoice text.
8. **Class A (Phrase injection)** — Match 40+ known LLM jailbreak phrases against the fully-reconstructed string.

The `injectionPhrases` array covers direct overrides, role hijacking, system token injection (`<|im_start|>`, `[/inst]`), and bypass commands.

**`internal/compliance/sar.go`** — Suspicious Activity Report generation. Likely triggers on high-severity intents or anomalous transaction patterns for regulatory filing.

**`internal/risk/engine.go`** — Pre-authorization risk scoring. Runs before the transaction is forwarded to the Rust engine.

**`internal/policy/invariants.go`** — Business rule enforcement. Catches negative amounts, self-transfers, and other invariant violations in Go before they reach Rust.

### 2c. The Agentic / LLM Layer

This is the **Phase F "Agentic Banking" subsystem** — a natural language payment interface. The flow:

**`internal/intent/classifier.go`** — Deterministic NLP classification. Runs **before** the LLM to pre-classify the request. It implements three n8n-equivalent nodes in Go:

- **Text Feature Engineering** — Regex-based PII detection (UzCard `8600`, Humo `5614`, Uzbek phone `+998XXXXXXXXX`), security term detection, urgency detection.
- **Language Detection** — Heuristic scorer for Uzbek (Latin), Russian (Cyrillic), English. Uses Cyrillic rune ratio + Uzbek morphological suffix patterns (`-lar`, `-gan`, `-moqda`).
- **Rule-Based Severity Classifier** — Weighted scoring across critical/high/medium/low. `SECURITY_ALERT` and `FRAUD_REPORT` go directly to `critical`; `CARD_BLOCK` to `high`.

**`internal/llm/client.go`** — Client for an LLM inference endpoint (local Llama 3.2 based on the docs). The rule engine output and the LLM advisory are fused in a **Pre-Fusion Normalizer** — the rule engine provides a `Source: "RULE_ENGINE"` result and the LLM provides an advisory; the pipeline selects the more conservative of the two.

**`internal/icde/`** — **Intent Commit and Deterministic Execution** subsystem.
- `commit.go` — Commits the resolved intent to a canonical representation.
- `resolver.go` — Resolves the LLM output against the rule engine classification.
- `signer.go` — Signs the resolved intent with the gateway's ephemeral Ed25519 private key, producing the `intent_hash` and `signature` fields that the Rust engine verifies.

**`internal/intent/schema.go`** — Zod-equivalent schema definitions for intent validation.
**`internal/intent/extractor.go`** — Extracts structured fields (amount, target account, action type) from the LLM's natural language output.

### 2d. Transaction Lifecycle: Go Side

1. Client HTTP POST arrives at `fasthttp`.
2. `PoWMiddleware` validates the PoW nonce — reject if invalid.
3. `DeadlineMiddleware` checks TTL — reject if expired.
4. `SignatureMiddleware` dispatches Ed25519 verification to crypto worker pool — reject if signature fails.
5. `internal/api/sanitizer.go` sanitizes the request body.
6. `internal/firewall/semantic.go` runs the 8-stage prompt injection filter — reject if any class matches.
7. `internal/handler/payment.go` receives the clean request.
8. `internal/intent/classifier.go` runs deterministic NLP classification.
9. `internal/llm/client.go` calls the LLM for advisory intent extraction.
10. `internal/icde/resolver.go` fuses rule engine + LLM results.
11. `internal/risk/engine.go` applies risk scoring.
12. `internal/compliance/sar.go` checks for SAR triggers.
13. `internal/policy/invariants.go` validates business rules.
14. `internal/txbuilder/envelope.go` builds the **32-byte binary payload** (SenderID, ReceiverID, Amount, Nonce — all little-endian, matching the Rust `#[repr(C)]` ABI).
15. `internal/aeronpub/publisher.go` wraps the 32-byte payload in a **512-byte `TransactionEnvelope`**, signs it with the ephemeral Ed25519 key, and calls `pub.Offer()` to multicast it over Aeron UDP to `127.0.0.1:40123` stream `1001`.

---

## 3. The Iron Vault: Rust Deterministic Execution Engine

### 3a. The Binary Wire Contract

The canonical wire format is defined in `envelope.rs`:

```
TransactionEnvelope [512 bytes, #repr(C)]
  [0:8]    term          u64  — Raft leader epoch
  [8:16]   gsn           u64  — Global Sequence Number
  [16:48]  intent_hash   [u8;32] — SHA-256 of intent
  [48:112] signature     [u8;64] — Ed25519 signature
  [112:120] ttl_timestamp u64  — UNIX epoch nanoseconds
  [120:124] sender        u32
  [124:128] receiver      u32
  [128:136] amount        u64
  [136:144] nonce         u64
  [144:145] action        u8   — 1=Transfer, 2=PayBill, 3=CardBlock
  [145:512] _padding      [u8;367]
```

A compile-time `const _: () = assert!(size_of::<TransactionEnvelope>() == 512)` enforces this ABI. Any field addition that breaks the 512-byte boundary causes a **compile-time failure**, not a runtime corruption.

### 3b. `network_rx.rs` — The Zero-Trust Aeron Subscriber

This is the engine's ingress. It connects to the Aeron Media Driver at `/dev/shm/aeron-bobur` and subscribes to UDP stream `1001` on `127.0.0.1:40123`.

For every incoming 512-byte fragment, it runs **four security gates in sequence** before touching the Disruptor:

1. **Length gate** — `if length as usize != ENVELOPE_SIZE { return; }` — drop malformed frames.
2. **TTL gate** — `now_ns - timestamp_ns > 5_000_000_000` (5 seconds) — drop stale frames. This is the "Clock Drift Suicide Rule" — an envelope more than 5 seconds old is either a replay or a clock drift and is unconditionally dropped.
3. **Idempotency gate** — `IdempotencyGuard` maintains two `HashSet`s of seen nonces and seen intent hashes. Duplicate nonce or duplicate intent hash → drop. This is the in-memory ICDE (Intent Commit Deduplication Engine).
4. **Cryptographic gate** — `ed25519_dalek::VerifyingKey::verify_strict()` verifies the Ed25519 signature against the hardcoded Go orchestrator public key (`GO_PUBLIC_KEY: [u8; 32]`). Invalid signature → remove nonce/intent from the idempotency cache (to avoid poisoning it) and drop. This is **Zero-Trust IPC** — the Rust engine does not trust the Go layer blindly even though they run on the same machine.

After all four gates pass, the envelope is written into the **LMAX Disruptor ring buffer** and `published_sequence` is incremented with `Ordering::Release`.

The idle strategy is a three-phase backoff: `Spin → Yield → Park(1µs)` — identical to the LMAX Disruptor's `BusySpinWaitStrategy` → `YieldingWaitStrategy` → `SleepingWaitStrategy` progression.

### 3c. The LMAX Disruptor

Defined inline in `main.rs`:

```rust
pub struct Disruptor {
    ring_ptr:                *mut TransactionEnvelope,
    pub published_sequence:  PaddedAtomicU64,  // Producer cursor
    pub ledger_sequence:     PaddedAtomicU64,  // Consumer 1: Ledger thread
    pub wal_sequence:        PaddedAtomicU64,  // Consumer 2: WAL thread
    pub replicator_sequence: PaddedAtomicU64,  // Consumer 3: Replicator thread
}
```

`RING_SIZE = 8,192` (power of two → bitwise mask `seq & MASK` instead of modulo). `PaddedAtomicU64` is `#[repr(align(64))]` — each sequence counter occupies its own CPU cache line, eliminating **false sharing** between consumer threads.

Three independent consumer threads read from the ring:
- **Ledger thread** — applies `Ledger::process_envelope()` (balance mutation).
- **WAL thread** — persists to the Write-Ahead Log via `io_uring`.
- **Replicator thread** — ships envelopes to follower nodes via Aeron UDP.

### 3d. `mutator.rs` — The State Machine

The `Ledger` struct holds a `Box<[Account]>` of 100,000 pre-allocated accounts. `Box<[Account]>` is used instead of `Vec<Account>` — it locks the capacity at compile time and removes the 8-byte capacity field overhead.

```rust
#[repr(C)]
pub struct Account {
    pub balance: u64,
    pub status:  AccountStatus,
    pub _padding: [u8; 7],  // 16 bytes total
}
```

`apply_mutation()` is the critical hot path:
1. Parse `action_byte` into `ActionType` (Transfer/PayBill/CardBlock).
2. Global bounds check: `sender < 100_000 && receiver < 100_000`.
3. For Transfer/PayBill: `execute_transfer()` — uses `unsafe get_unchecked_mut()` (safe because bounds are proven above), checks blocked status, checks sufficient balance, uses `checked_add()` on receiver to prevent overflow.
4. For CardBlock: `execute_block()` — sets `AccountStatus::Blocked`.

The doc comment states **expected latency: ~15–30ns**, achievable because the 100,000 × 16-byte account array fits in **1.6 MB** — within L2 cache on modern server CPUs.

`main.rs`'s `Ledger` is a parallel, more feature-complete implementation that adds nonce tracking (`last_nonce: u64`) for replay protection at the ledger level (second line of defense after `network_rx.rs`).

### 3e. `wal.rs` — The Write-Ahead Log

**Design**: 8 KB fixed-size blocks, 15 envelopes per block, 4-byte CRC32 (IEEE 802.3) trailer at offset 8,188.

**Writer** — `WalWriter` uses `O_DIRECT | O_SYNC` file flags (bypassing the page cache) and **`io_uring`** for async kernel I/O submission. `AlignedBuffer` is allocated via `mmap` + `mlock` — pinning the pages into physical RAM to eliminate page-fault stalls on the write path.

**Recovery** — `recover_ledger()` reads blocks sequentially, verifies CRC32 on each block (detecting torn writes at crash boundaries), and re-applies envelopes to the ledger by calling `process_envelope()`. Snapshot-aware: if a snapshot exists at sequence N, WAL replay seeks directly to block `N / 15`, skipping re-applying already-snapshotted state.

**Snapshots** — `trigger_cow_snapshot()` calls `libc::fork()`. The child process gets a **copy-on-write clone** of the parent's memory via the OS's CoW page semantics. The child serializes the account array to a `.bin.tmp` file, computes CRC32, calls `fsync()`, then `rename()` to atomically commit. `rename()` is POSIX-atomic — there is never a moment where a partially-written snapshot is visible. The parent reaps the child with `WNOHANG` on the next tick. Snapshots trigger every 100 envelopes (`SNAPSHOT_INTERVAL = 100`).

### 3f. `consensus.rs` & `election.rs` — Raft Consensus

REVENANT implements a **3-node Raft cluster** (Tashkent primary, Samarkand follower, Fergana follower). The consensus model:

**`consensus.rs` — ClusterState**:
- Leader maintains an `in_flight` ring buffer (`MAX_IN_FLIGHT = 1024`) of proposals awaiting quorum.
- `append_as_leader()` — slots an envelope into the ring, sets `acks = 1` (leader self-vote), multicasts via Aeron.
- `handle_replica_ack()` — increments `acks`; when `acks >= 2` (quorum = 2 of 3), advances `commit_index` sequentially (gaps are held — no out-of-order commits).
- `append_as_follower()` — enforces **strict monotonicity**: `env.sequence_id == commit_index + 1` for acceptance. Gaps trigger a NAK/replay request. Stale frames (already committed) are silently dropped.

**`election.rs` — ElectionState**:
- All nodes boot as `Follower`.
- Election timeout is randomized using `XorShift32` PRNG (zero-allocation, no `rand` crate dependency): 150–300ms range.
- On timeout: transition to `Candidate`, increment term, vote for self, multicast `RequestVote`.
- `handle_request_vote()` enforces three Raft rules: (1) term dominance, (2) one vote per term, (3) candidate must have `last_commit_index >= my_commit_index`.
- `handle_vote_response()`: `votes_received >= 2` → promote to `Leader`, immediately broadcast heartbeat.

The `RequestVote` and `VoteResponse` structs are `#[repr(C)]` — C-ABI compatible for direct Aeron UDP transmission without serialization overhead.

### 3g. `xdp_filter.c` — eBPF/XDP Kernel Bypass (Hardware Firewall)

This is the **outermost** security layer — operating below the OS network stack, at the NIC driver level.

```c
#define TARGET_PORT 40123
#define MAX_SENDERS 100000
struct bpf_map_def SEC("maps") nonce_map = { BPF_MAP_TYPE_HASH, sizeof(u32), sizeof(u64), MAX_SENDERS };
```

The XDP program attaches to the network interface and for every incoming UDP packet on port 40123:

1. Parse Ethernet → IP → UDP headers (with bounds checks required by the BPF verifier).
2. Extract `sender_id` (u32) and `nonce` (u64) from fixed offsets in the Aeron payload.
3. Look up `sender_id` in the `nonce_map` BPF hash map.
4. If `nonce <= last_nonce && nonce != 0` → **`XDP_DROP`** — the packet is destroyed before it reaches any userspace buffer.
5. On pass: update `nonce_map[sender_id] = nonce`.

In `main.rs`, `attach_and_hydrate_ebpf()` uses the `aya` crate to:
- Load the compiled `xdp_filter.o` ELF into the kernel.
- Attach it to the `lo` interface with `XdpFlags::SKB_MODE`.
- **Hydrate the `nonce_map`** with all non-zero `last_nonce` values from the recovered ledger snapshot, so the kernel firewall is replay-aware from the moment it activates — even after a restart.

The result is a **three-layer replay defense**:
1. **Kernel/NIC** — XDP drops replays at wire speed (pre-syscall).
2. **Rust network_rx.rs** — `IdempotencyGuard` HashSet catches any that pass XDP.
3. **Rust Ledger** — `nonce <= last_nonce` check in `process_envelope()` as the final gate.

---

## 4. Operations, UI, and Load Testing

### Dashboard (`/dashboard`)

Built with React + Vite. The key component is `TPSChart.jsx`.

**Architecture insight**: The component is deliberately designed to **bypass React's Virtual DOM** on the hot render path:

- `canvasRef`, `tpsValueRef`, `peakValueRef` are DOM refs — raw pointers to DOM nodes.
- The `render()` function runs on `requestAnimationFrame` — it does **not** call `setState()` or trigger re-renders.
- TPS display updates via `tpsLabel.innerText = tps.toLocaleString()` — a **direct DOM mutation**.
- The chart scrolls by calling `ctx.drawImage(canvas, -1, 0)` — shifting the entire canvas buffer left by 1px per frame, then drawing the new data point at the right edge. This is the **oscilloscope rendering pattern** — O(1) per frame regardless of history length.

Data source: WebSocket at `ws://127.0.0.1:8080/api/v1/firehose` (`cmd/firehose/main.go`). The chart auto-scales: if TPS exceeds 90% of the current max scale, the scale expands by 1.2×.

### Load Testing (`/scripts`)

**`generate_ammo.go`** — Pre-mines 10,000 valid test payloads using all CPU cores. For each payload:
1. Generates a fresh Ed25519 keypair (`ed25519.GenerateKey`).
2. Signs the payload JSON.
3. **Mines a PoW nonce** (`minePoWNonce`): iterates `nonce++` until `SHA-256(pubkey || nonce)[0:2] == 0x00 0x00`. This is 2-byte PoW — expected ~65,536 iterations per nonce on average.
4. Stores `{payload, pub_key, signature, pow_nonce}` in `ammo.json`.

**Why pre-mine?** In HFT load testing, the client cannot afford to compute PoW during the test — it would throttle throughput to the PoW mining speed. Pre-mining decouples cryptographic prep from throughput measurement.

**`load_test.js`** — JavaScript load test runner (likely k6 or artillery) that reads `ammo.json` and fires requests at the gateway at maximum concurrency, measuring P50/P99/P999 latencies and peak TPS.

---

## 5. End-to-End Transaction Flow

```
[Client] POST /api/v1/payment
         Headers: X-Signature, X-Public-Key, X-PoW-Nonce
         Body: {"text": "send 500,000 UZS to account 86001234..."}
         │
         ▼
[GATEWAY — cmd/gateway]
  PoW Middleware          → SHA-256(pubkey||nonce)[0:2] == 0x00? else 429
  Deadline Middleware     → TTL expired? else 408
  Signature Middleware    → Ed25519.Verify(pubkey, body, sig) via SEDA pool? else 401
         │
         ▼
[INGRESS SANITIZATION]
  api/sanitizer.go        → HTTP-level input cleaning
  firewall/semantic.go    → 8-stage prompt injection filter (Bidi/TagBlock/ZeroWidth/HTML/Phrase)
         │
         ▼
[AGENTIC PIPELINE]
  intent/classifier.go    → Deterministic NLP: language=uz, intent=TRANSFER_ISSUE, severity=medium
  llm/client.go           → Llama 3.2: extract {amount:500000, target:"86001234...", action:"transfer"}
  icde/resolver.go        → Fuse rule engine + LLM advisory (conservative merge)
  risk/engine.go          → Risk score: PASS
  compliance/sar.go       → SAR check: no trigger
  policy/invariants.go    → Business rules: amount > 0, sender != receiver: PASS
         │
         ▼
[TRANSACTION BUILDING]
  txbuilder/envelope.go   → 32-byte binary payload:
                              SenderID   = SHA-256("sender:"+traceID)[:4] mod 99998 + 1
                              ReceiverID = 99999 (Phase C sentinel)
                              Amount     = 500_000_00 tiyin (int64 LE)
                              Nonce      = SHA-256("nonce:"+traceID+"|"+amount)[:4]
         │
         ▼
[AERON IPC BRIDGE]
  aeronpub/publisher.go   → Wraps 32-byte payload in 512-byte TransactionEnvelope:
                              frame[0]   = 0x01 (version)
                              frame[8]   = timestamp_ns (LE u64)
                              frame[88]  = payload (32 bytes)
                              frame[128] = Ed25519.Sign(privKey, payload) [64 bytes]
                            → pub.Offer(buffer) over UDP:127.0.0.1:40123 stream 1001
         │
         ▼  [Aeron Media Driver — /dev/shm/aeron-bobur]
         │
         ▼
[RUST ENGINE — revenant-engine]

  XDP Kernel Firewall     → NIC-level: nonce_map[sender_id] check → XDP_DROP if replay
         │
         ▼
  network_rx.rs           → Aeron subscriber polls stream 1001:
    Gate 1: Length == 512?
    Gate 2: now_ns - ttl_timestamp < 5s?
    Gate 3: IdempotencyGuard.is_novel(nonce, intent_hash)?
    Gate 4: ed25519_dalek.verify_strict(GO_PUBLIC_KEY, intent_hash, signature)?
    → Write to Disruptor slot[next_seq]
    → published_sequence.store(next_seq, Release)
         │
         ▼  [LMAX Disruptor — 8,192 slot ring, three independent consumers]
         │
         ├──► Thread: revenant-ledger
         │    main.rs Ledger::process_envelope():
         │      Read sender, receiver, amount, nonce from envelope (LE u32/u64)
         │      Replay gate: nonce <= accounts[sender].last_nonce → drop
         │      Balance check: accounts[sender].balance < amount → REJECT (status=1)
         │      Mutate: accounts[sender].balance -= amount
         │               accounts[receiver].balance += amount (saturating_add)
         │               accounts[sender].last_nonce = nonce
         │      ACK: ack_tx.try_send((intent_hash, 0)) → Egress thread → UDP:8081
         │
         ├──► Thread: revenant-wal
         │    wal.rs WalWriter::append():
         │      Copy 512-byte envelope into AlignedBuffer (mlock'd, O_DIRECT)
         │      Every 15 envelopes: compute CRC32, io_uring Write → WAL file
         │      Every 100 envelopes: fork() → CoW snapshot → fsync → rename (atomic)
         │
         └──► Thread: revenant-replicator
              main.rs spawn_replicator_thread():
                Aeron publish → UDP:127.0.0.1:40124 stream 1002 → Follower nodes
                Lag ceiling: if lag > 4,096 slots, skip ahead (follower is offline)
                Idle strategy: Spin(50) → Yield(100) → Sleep(1µs)
```

The Egress thread receives ACKs from the Ledger thread via `mpsc::sync_channel` and forwards them as 33-byte UDP datagrams to the Go gateway at `127.0.0.1:8081` — closing the response loop back to the waiting HTTP client.

---

## Key Architectural Properties

| Property | Implementation |
|---|---|
| **Zero-allocation hot path** | `fasthttp`, stack arrays, `Box<[Account]>`, `#[repr(C)]` |
| **Kernel bypass** | eBPF/XDP at NIC level, Aeron UDP bypasses TCP stack |
| **Deterministic execution** | Single-threaded ledger mutation, no locks, LMAX Disruptor |
| **Durability** | io_uring WAL with O_DIRECT + O_SYNC, CRC32 per block |
| **Point-in-time recovery** | CoW fork() snapshots + WAL replay from snapshot boundary |
| **High availability** | Raft consensus (3 nodes), randomized election timeouts |
| **Defense in depth** | XDP → network_rx → Ledger (3 replay gates) |
| **Zero-Trust IPC** | Ed25519 signature on every envelope, hardcoded public key in Rust |
| **Prompt injection defense** | 8-class semantic firewall before any LLM call |
| **Sovereignty** | All keys ephemeral, local Llama 3.2, no external cloud dependencies |
