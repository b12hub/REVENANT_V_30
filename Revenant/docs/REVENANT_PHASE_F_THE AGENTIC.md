**REVENANT PHASE F: THE AGENTIC ROADMAP (v5.0 — THE APEX ARCHITECTURE)**

This is the definitive, master architectural blueprint for the REVENANT Sovereign Engine. It consolidates the Agentic UX, the ICDE Cryptographic Vault, the Planetary Sharding Topology, and the HFT Silicon Optimizations into a single, mathematically rigorous execution pipeline.

The pipeline flows strictly from the highest layer of abstraction (Global Edge) down to the bare metal silicon.

### 1. The Global Edge & Agentic Ingress Layer (Go)

*This layer handles untrusted user input, geographically distributed ingress, and the transition from probabilistic natural language to deterministic data structures.*

* **Global Gateways:** Deployed across distributed PoPs (Tashkent, Frankfurt, Singapore) terminating TLS and handling initial TCP Slowloris load-shedding via NGINX Plus / HAProxy.
* **The Semantic Firewall (`firewall.go`):** Scans OCR'd B2B invoices and user text to strip adversarial Unicode, HTML comments, and prompt-injection triggers (e.g., "ignore instructions") *before* the LLM evaluates the payload.
* **Constrained Intent Extractor (`intent.go`):** Cages the local Llama 3.2 model using grammar-constrained decoding (CSTI). It is physically impossible for the AI to output anything other than a strict JSON schema containing pre-approved enums (`TRANSFER`, `PAY_BILL`, `CARD_BLOCK`).

### 2. The ICDE Cryptographic Boundary (Stripe/Coinbase Standard)

*The Intent-Commit + Deterministic Execution (ICDE) layer mathematically locks the transaction, removing the AI entirely from the chain of trust.*

* **Entity Resolver / GraphRAG (`resolver.go`):** The LLM never processes raw account numbers. Go queries a deterministic graph database to map semantic targets ("mom", "supplier") to hard integer `account_id`s. Ambiguity halts the pipeline.
* **Intent Canonicalization & Hashing (`commit.go`):** Converts the JSON intent into a sorted, deterministic string and hashes it: `intent_hash = SHA256(canonical_json)`. This hash becomes the immutable identity of the transaction.
* **Idempotency Store (`idempotency.go`):** Checks the `intent_hash` against an LRU cache or Redis. Duplicate hashes are instantly killed to mathematically prevent AI loops and replay double-spends.
* **Risk Engine & HITL Thresholds (`risk.go`):** Evaluates the normalized request against velocity, amount, and device fingerprinting.
* **Score 0-30:** Auto-execute.
* **Score 30-80:** Trigger Out-of-Band (OOB) Authorization.
* **Score 80+:** Hard reject or route to human compliance officer.


* **Out-of-Band (OOB) Authorization:** The `intent_hash` is sent to the user's mobile hardware enclave. The device signs the hash with an Ed25519 private key. Go verifies the signature (`ed25519.Verify(pubkey, intent_hash, signature)`) before allowing the transaction to proceed.

### 3. Regional Sequencer & Planetary Routing (Visa/Nasdaq Scale)

*This layer orchestrates horizontal scaling without sacrificing the determinism of the underlying single-threaded LMAX engines.*

* **Shard Router (`router.go`):** Routes transactions to specific execution nodes based on a modulo of the `account_id` (e.g., Accounts 0–99,999 map strictly to Shard 0).
* **Raft Log Replicator:** A Leader sequencer assigns a strict, monotonic sequence number to the transaction and replicates it to Regional Followers (ensuring regional fault tolerance) before passing it to execution.
* **Saga Transaction Planner (`saga.go`):** Orchestrates multi-step intents. Operates as a state machine (`PENDING` → `STEP_1` → `COMMITTED` / `ROLLBACK`). If a transaction crosses shards (Mom is on Shard 0, User is on Shard 2), it executes a Two-Phase Commit (`PREPARE_TRANSFER` → `COMMIT_CREDIT`).
* **Aeron Multiplexer (`aeronpub.go`):** Replaces a single `/dev/shm` bridge with multiple dedicated Aeron UDP IPC streams (one isolated stream per shard).

### 4. Deterministic Execution Shards (Rust LMAX)

*The sovereign state machine. This layer operates entirely in RAM and rejects anything lacking cryptographic proof.*

* **Parallel LMAX Engines:** 10 to 100 parallel instances of `revenant-engine` running independently. Each Rust binary only polls its specific Aeron shard stream.
* **The Iron Vault (`network_rx.rs` & `mutator.rs`):** The Rust Engine receives the 512-byte C-struct (now upgraded to include `intent_hash: [u8;32]`). It performs the final, non-negotiable checks: Ed25519 cryptographic verification, 5-second TTL bounds, Nonce deduplication, and `intent_hash` idempotency. Only then does it execute the mutation.

### 5. HFT Silicon & Micro-Architecture Optimizations (CME/HFT Speed)

*The final nanosecond-scale optimizations to push execution latency down to ~20–40µs per pipeline.*

* **Busy-Spin Polling:** The Rust Aeron subscriber and LMAX Disruptor are configured to use a `BusySpinIdleStrategy`. By replacing `sleep()` or `yield()` with a tight `std::hint::spin_loop()`, the consumer thread never leaves the CPU, eliminating tens of microseconds of OS scheduler context-switching.
* **Kernel-Bypass Networking:** Relying exclusively on Aeron’s shared-memory IPC and DPDK/Solarflare mechanisms to move bytes from the Go gateway directly into Rust userspace memory, entirely bypassing the Linux kernel network stack and socket buffers.
* **Cache-Line Padding:** Structs (such as sequence counters) are forced into 64-byte alignments (`#[repr(align(64))]`) to prevent False Sharing, ensuring parallel CPU cores do not invalidate each other's L1/L2 caches.
* **OS-Level Thread Pinning:** Utilizing Linux kernel boot flags (`isolcpus`, `nohz_full`, `rcu_nocbs`) to physically isolate specific CPU cores. The Rust execution threads and Aeron RX threads are pinned to these isolated cores, guaranteeing zero OS jitter or interrupts during the transaction lifecycle.
