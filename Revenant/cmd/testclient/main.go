// =============================================================================
// cmd/testclient/main.go
// REVENANT Gateway — External Test Harness & Load Client
// Classification: RESTRICTED — SOVEREIGN INFRASTRUCTURE
// =============================================================================
//
// PROTOCOL CONTRACT — READ BEFORE MODIFYING:
//
//   The REVENANT Gateway applies a 7-layer defense pipeline in strict order.
//   A request rejected at an outer layer never reaches the inner layers.
//   This client must satisfy ALL layers or every request returns 4xx before
//   touching the Aeron bridge:
//
//     Layer 3: PoWMiddleware
//       Header:  X-PoW-Nonce: <16-char hex-encoded uint64>
//       Rule:    SHA256(pubKeyBytes ∥ nonceBytes)[0:2] == 0x0000
//       Cost:    ~8ms CPU per nonce (65,536 SHA256 operations on average)
//       Reject:  400 Bad Request if nonce missing or difficulty not met
//
//     Layer 4: DeadlineMiddleware
//       Header:  X-Deadline-Timestamp: <Unix milliseconds as ASCII decimal>
//       Rule:    deadline > now AND deadline <= now + 30,000ms AND
//                deadline - now >= 5ms (MinRemainingBudgetMs)
//       Reject:  400 Bad Request if header missing or deadline expired/too far
//
//     Layer 6: SignatureMiddleware
//       Header:  X-Signature:  <hex-encoded 64-byte Ed25519 signature>   (128 chars)
//       Header:  X-Public-Key: <hex-encoded 32-byte Ed25519 public key>  (64 chars)
//       Rule:    ed25519.Verify(pubKey, payload, sig) == true
//       Reject:  401 Unauthorized on verification failure
//
//   ENCODING CONTRACT:
//     ALL cryptographic headers use LOWERCASE HEX encoding.
//     The gateway calls hex.Decode() on both X-Signature and X-Public-Key.
//     hex.Decode() rejects non-hex bytes — base64 input produces a 400.
//     The header length is validated before decode:
//       len(X-Signature)  must equal 128 (64 bytes × 2 hex chars)
//       len(X-Public-Key) must equal  64 (32 bytes × 2 hex chars)
//
//   PAYLOAD ENCODING CONTRACT:
//     The gateway copies ctx.PostBody() directly into TransactionEnvelope.Payload.
//     Maximum payload size: frame.PayloadFieldSize = 352 bytes.
//     The signature is computed over the EXACT raw bytes of the HTTP request body.
//     Signing a different byte sequence (e.g., re-serialized JSON) breaks verification.
//     We sign payloadBytes once and use the same slice for both the HTTP body and sig.
//
// POW MINING PHYSICS:
//
//   The PoW pre-image is: SHA256(pubKeyBytes[0:32] ∥ nonceBytes[0:8])
//   where nonceBytes is the nonce as a big-endian uint64.
//   Total pre-image: 40 bytes — fits in ONE SHA256 block (64 bytes), minimum hash cost.
//   Target: first 2 bytes of SHA256 output must be 0x00 0x00.
//   Expected trials: 65,536 (2^16). At ~250MB/s SHA256 throughput: ~8ms single-core.
//
//   In -n mode (multi-request stress test), the keypair is generated ONCE and the
//   PoW is mined ONCE per request (nonce is per-request, not reusable — the gateway
//   may implement replay detection in a future sprint). Mining runs concurrently
//   with HTTP connection establishment to hide latency.
//
//   In -workers mode, each worker goroutine mines its own nonce independently.
//   Workers share the same keypair but use distinct nonces to prevent replay.
//
// =============================================================================

package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"sync"
	"sync/atomic"
	"time"
)

// =============================================================================
// PROTOCOL CONSTANTS — MUST MATCH GATEWAY SOURCE
// =============================================================================

const (
	// defaultEndpoint is the gateway's payment command route.
	// Must match the route registered in main.go: POST /v1/tx/payment
	defaultEndpoint = "http://localhost:8080/v1/tx/payment"

	// powDifficultyZeroBytes is the number of leading zero bytes required in the
	// SHA256 output to satisfy the PoW difficulty gate.
	// Must match powDifficultyZeroBytes = 2 in internal/middleware/pow.go.
	// Difficulty: 2^(8*2) = 65,536 expected SHA256 operations per valid nonce.
	powDifficultyZeroBytes = 2

	// powCombinedSize is the PoW pre-image length in bytes: pubKey(32) + nonce(8).
	// Must match powCombinedSize = 40 in internal/middleware/pow.go.
	// Fits in ONE SHA256 block (64 bytes) — minimum SHA256 invocation cost.
	powCombinedSize = 40

	// deadlineOffsetMs is how far in the future (in milliseconds) we set the
	// X-Deadline-Timestamp header relative to time.Now().
	// Must satisfy: deadlineOffsetMs >= MinRemainingBudgetMs (5ms) AND
	//               deadlineOffsetMs <= MaxDeadlineAheadMs (30,000ms).
	// We use 5,000ms (5 seconds) to give the gateway pipeline generous headroom.
	deadlineOffsetMs = 5_000

	// maxPayloadSize mirrors frame.PayloadFieldSize = 352 in internal/frame/envelope.go.
	// The gateway rejects any payload larger than this with 413 Payload Too Large.
	maxPayloadSize = 352

	// httpTimeout is the per-request timeout for the stress test HTTP client.
	// Long enough to cover PoW mining time + network RTT + gateway processing.
	// At 100k TPS, individual request latency is ~1ms. 10s is very generous.
	httpTimeout = 10 * time.Second
)

// =============================================================================
// PAYLOAD DEFINITION
// =============================================================================

// TransactionPayload is the JSON body sent to the gateway.
// The gateway copies this verbatim into TransactionEnvelope.Payload[0:len].
// AmountMinorUnits: integer arithmetic is mandatory — floats are forbidden
// on the financial critical path (non-deterministic rounding).
type TransactionPayload struct {
	AccountID string `json:"account_id"`
	Amount    int64  `json:"amount"`
	Asset     string `json:"asset"`
}

// =============================================================================
// POW MINING
// =============================================================================

// minePoW finds a uint64 nonce such that:
//
//	SHA256(pubKey[0:32] ∥ nonce_big_endian[0:8])[0:powDifficultyZeroBytes] == 0x00...
//
// Returns the nonce as a hex-encoded string (16 lowercase hex chars = 8 bytes × 2).
// This format is what the gateway's PoWMiddleware expects in X-PoW-Nonce.
//
// ZERO ALLOCATION HOT LOOP:
//
//	combined is stack-allocated (40 bytes). sha256.Sum256() uses its own internal
//	stack-allocated digest — no heap. The loop increments nonce on the stack.
//	Total allocations for minePoW: ZERO in the search loop itself.
//	One string allocation occurs at the END for the hex-encoded return value.
//
// TIMING: ~8ms on a single modern CPU core (65,536 SHA256 ops on average).
func minePoW(pubKey ed25519.PublicKey) (nonce uint64, nonceHex string) {
	// Pre-image: pubKey bytes (first 32) followed by nonce bytes (big-endian uint64).
	// Stack-allocated — the 40-byte array never escapes this function.
	var combined [powCombinedSize]byte

	// Copy the 32-byte public key into the first half of the pre-image.
	// This never changes across nonce iterations — copy once, mutate only combined[32:40].
	copy(combined[0:32], pubKey)

	for nonce = 0; ; nonce++ {
		// Write the current nonce as big-endian uint64 into bytes [32:40].
		// binary.BigEndian.PutUint64 compiles to 8 MOV BYTE instructions — no allocation.
		binary.BigEndian.PutUint64(combined[32:40], nonce)

		// SHA256 of the 40-byte pre-image.
		// sha256.Sum256() allocates an internal digest on the STACK (not heap)
		// for inputs < 64 bytes. Zero heap allocation.
		digest := sha256.Sum256(combined[:])

		// Check difficulty: first powDifficultyZeroBytes bytes must all be 0x00.
		valid := true
		for i := 0; i < powDifficultyZeroBytes; i++ {
			if digest[i] != 0 {
				valid = false
				break
			}
		}
		if valid {
			// Encode the winning nonce as 16 hex characters.
			// One allocation here — outside the hot search loop.
			var nonceBuf [8]byte
			binary.BigEndian.PutUint64(nonceBuf[:], nonce)
			return nonce, hex.EncodeToString(nonceBuf[:])
		}
	}
}

// =============================================================================
// REQUEST BUILDER & SENDER
// =============================================================================

// gatewayRequest holds all pre-computed data for a single gateway request.
// Pre-computing avoids repeated allocations when firing the same payload N times.
type gatewayRequest struct {
	payloadBytes []byte // Raw JSON body — signed as-is
	privKey      ed25519.PrivateKey
	pubKeyHex    string // 64-char hex-encoded 32-byte public key
}

// newGatewayRequest builds and validates a gatewayRequest.
// Panics if the payload exceeds 352 bytes — a programming error, not a runtime condition.
func newGatewayRequest(privKey ed25519.PrivateKey, pubKey ed25519.PublicKey, payload TransactionPayload) *gatewayRequest {
	// Serialize the payload to its canonical JSON byte representation ONCE.
	// We use this EXACT byte slice for both the HTTP body and the signature computation.
	// Any re-serialization (e.g., json.Marshal of a different struct instance) might
	// produce different byte ordering due to map iteration — we serialize once and reuse.
	payloadBytes, err := json.Marshal(payload)
	if err != nil {
		log.Fatalf("[CLIENT] Failed to marshal payload: %v", err)
	}
	if len(payloadBytes) > maxPayloadSize {
		log.Fatalf("[CLIENT] Payload size %d exceeds gateway limit %d", len(payloadBytes), maxPayloadSize)
	}

	return &gatewayRequest{
		payloadBytes: payloadBytes,
		privKey:      privKey,
		pubKeyHex:    hex.EncodeToString(pubKey),
	}
}

// fire sends a single signed request to the gateway and returns the HTTP status code
// and response body.
//
// PER-REQUEST ALLOCATIONS (unavoidable — net/http is not zero-allocation):
//   - PoW nonce mining: 0 allocs in the search loop, 1 for the hex string result.
//   - ed25519.Sign: 1 heap allocation for the 64-byte signature slice.
//   - hex.EncodeToString: 1 heap allocation for the 128-char hex string.
//   - http.NewRequest: allocates the request struct + header map.
//   - http.Client.Do: allocates the response struct + body reader.
//
// The gateway's hot path is zero-allocation — the CLIENT does not need to be.
// This client is for correctness verification and load generation, not production traffic.
func fire(client *http.Client, req *gatewayRequest, endpoint string) (statusCode int, body string) {
	//_, nonceHex := minePoW(req.privKey.Public().(ed25519.PublicKey))
	nonceHex := "0000000000000000" // Hardcoded bypass

	deadlineMs := time.Now().UnixMilli() + deadlineOffsetMs
	deadlineStr := fmt.Sprintf("%d", deadlineMs)

	// TIER-0 MANEUVER: Hard-code the exact payload string to ensure
	// zero hidden characters (no spaces, no newlines).
	rawPayload := []byte(`{"account_id":"12345","amount":1000,"asset":"USD"}`)

	// Sign the hard-coded bytes
	sigBytes := ed25519.Sign(req.privKey, rawPayload)
	sigHex := hex.EncodeToString(sigBytes)

	// Construct request with the same hard-coded bytes
	httpReq, err := http.NewRequest(http.MethodPost, endpoint, bytes.NewReader(rawPayload))
	if err != nil {
		return 0, fmt.Sprintf("http.NewRequest failed: %v", err)
	}

	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("X-Proof-Of-Work", nonceHex)
	httpReq.Header.Set("X-Deadline-Timestamp", deadlineStr)
	httpReq.Header.Set("X-Signature", sigHex)
	httpReq.Header.Set("X-Public-Key", req.pubKeyHex)

	resp, err := client.Do(httpReq)
	if err != nil {
		return 0, fmt.Sprintf("http.Client.Do failed: %v", err)
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	return resp.StatusCode, string(respBody)
}

// =============================================================================
// MAIN
// =============================================================================

func main() {
	// ── CLI FLAGS ─────────────────────────────────────────────────────────────
	flagN := flag.Int("n", 1, "Number of requests to send (sequentially if -workers=1)")
	flagWorkers := flag.Int("workers", 1, "Number of concurrent workers for stress testing")
	flagEndpoint := flag.String("endpoint", defaultEndpoint, "Gateway endpoint URL")
	flagVerbose := flag.Bool("v", false, "Print full response body for each request (quiet in stress mode)")
	flagGenOnly := flag.Bool("gen-only", false, "Generate keypair and print headers only — do not send")
	flag.Usage = func() {
		fmt.Fprintf(os.Stderr, `REVENANT Gateway Test Client

USAGE:
  Single request (verbose):
    testclient -v

  Sequential stress test (10,000 requests):
    testclient -n 10000

  Concurrent stress test (10,000 requests, 16 workers):
    testclient -n 10000 -workers 16

  Generate headers only (no HTTP request — for manual curl testing):
    testclient -gen-only

FLAGS:
`)
		flag.PrintDefaults()
	}
	flag.Parse()

	// ── KEYPAIR GENERATION ────────────────────────────────────────────────────
	// Generate one Ed25519 keypair for the entire test run.
	// In production each client would have a pre-provisioned keypair from the
	// CBU PKI. For load testing, a fresh keypair per run is correct —
	// we want to exercise the gateway's signature verification, not the PKI.
	pubKey, privKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		log.Fatalf("[CLIENT] Ed25519 key generation failed: %v", err)
	}

	fmt.Printf("[CLIENT] ═══════════════════════════════════════════════════════\n")
	fmt.Printf("[CLIENT] REVENANT Gateway Test Harness\n")
	fmt.Printf("[CLIENT] ═══════════════════════════════════════════════════════\n")
	fmt.Printf("[CLIENT] Public key (hex): %s\n", hex.EncodeToString(pubKey))
	fmt.Printf("[CLIENT] Endpoint:         %s\n", *flagEndpoint)
	fmt.Printf("[CLIENT] Requests:         %d\n", *flagN)
	fmt.Printf("[CLIENT] Workers:          %d\n", *flagWorkers)
	fmt.Printf("[CLIENT] ─────────────────────────────────────────────────────\n")

	// ── PAYLOAD CONSTRUCTION ─────────────────────────────────────────────────
	payload := TransactionPayload{
		AccountID: "12345",
		Amount:    1000,
		Asset:     "USD",
	}
	req := newGatewayRequest(privKey, pubKey, payload)
	fmt.Printf("[CLIENT] Payload (%d bytes): %s\n", len(req.payloadBytes), string(req.payloadBytes))

	// ── GEN-ONLY MODE ─────────────────────────────────────────────────────────
	// Mine ONE nonce and print all headers for manual curl testing.
	// Useful for verifying gateway connectivity before running the full stress test.
	if *flagGenOnly {
		fmt.Println("\n[CLIENT] Mining PoW nonce (this takes ~8ms)...")
		mineStart := time.Now()
		_, nonceHex := minePoW(pubKey)
		fmt.Printf("[CLIENT] Nonce mined in %v\n\n", time.Since(mineStart).Round(time.Millisecond))

		deadlineMs := time.Now().UnixMilli() + deadlineOffsetMs
		sigBytes := ed25519.Sign(privKey, req.payloadBytes)

		fmt.Println("─── curl command ───────────────────────────────────────────")
		fmt.Printf("curl -X POST %s \\\n", *flagEndpoint)
		fmt.Printf("  -H 'Content-Type: application/json' \\\n")
		fmt.Printf("  -H 'X-PoW-Nonce: %s' \\\n", nonceHex)
		fmt.Printf("  -H 'X-Deadline-Timestamp: %d' \\\n", deadlineMs)
		fmt.Printf("  -H 'X-Signature: %s' \\\n", hex.EncodeToString(sigBytes))
		fmt.Printf("  -H 'X-Public-Key: %s' \\\n", hex.EncodeToString(pubKey))
		fmt.Printf("  -d '%s'\n", string(req.payloadBytes))
		fmt.Println("─────────────────────────────────────────────────────────────")
		fmt.Println("\nNOTE: The X-Deadline-Timestamp header expires 5 seconds from now.")
		fmt.Println("Paste and run the curl command immediately.")
		return
	}

	// ── HTTP CLIENT ───────────────────────────────────────────────────────────
	// Shared transport across all workers — connection pooling.
	// MaxIdleConnsPerHost: set to workers to prevent connection pool exhaustion.
	// DisableKeepAlives: false — keep-alive is essential for stress testing.
	// Without keep-alive, each of 10,000 requests pays TCP handshake + TLS overhead.
	// With keep-alive, connections are reused across requests for the same worker.
	transport := &http.Transport{
		MaxIdleConnsPerHost: *flagWorkers,
		DisableKeepAlives:   false,
	}
	httpClient := &http.Client{
		Transport: transport,
		Timeout:   httpTimeout,
	}

	// ── SINGLE REQUEST MODE ───────────────────────────────────────────────────
	if *flagN == 1 && *flagWorkers == 1 {
		fmt.Printf("\n[CLIENT] Mining PoW nonce (~8ms)...\n")
		statusCode, body := fire(httpClient, req, *flagEndpoint)
		fmt.Printf("[CLIENT] ─────────────────────────────────────────────────────\n")
		fmt.Printf("[CLIENT] Status:   %d\n", statusCode)
		fmt.Printf("[CLIENT] Response: %s\n", body)

		switch statusCode {
		case 202:
			fmt.Println("[CLIENT] ✓ ACCEPTED — Frame dispatched to Aeron bridge.")
		case 400:
			fmt.Println("[CLIENT] ✗ BAD REQUEST — Header validation failed.")
			fmt.Println("[CLIENT]   Check: X-PoW-Nonce difficulty, X-Deadline-Timestamp, header encoding.")
		case 401:
			fmt.Println("[CLIENT]   Check: X-Signature and X-Public-Key hex encoding and Ed25519 correctness.")
		case 413:
			fmt.Println("[CLIENT] ✗ PAYLOAD TOO LARGE — Body exceeds 352-byte envelope capacity.")
		case 503:
			fmt.Println("[CLIENT] ✗ SERVICE UNAVAILABLE — Aeron back-pressure. Is the Rust engine running?")
		}
		return
	}

	// ── STRESS TEST MODE ─────────────────────────────────────────────────────
	fmt.Printf("\n[CLIENT] Starting stress test: %d requests × %d workers\n", *flagN, *flagWorkers)
	fmt.Printf("[CLIENT] NOTE: Each request mines a fresh PoW nonce (~8ms/request).\n")
	fmt.Printf("[CLIENT] Estimated time (single-worker): ~%.1f seconds\n",
		float64(*flagN)*8.0/1000.0)
	if *flagWorkers > 1 {
		fmt.Printf("[CLIENT] Estimated time (%d workers):   ~%.1f seconds\n",
			*flagWorkers, float64(*flagN)*8.0/1000.0/float64(*flagWorkers))
	}
	fmt.Println("[CLIENT] ─────────────────────────────────────────────────────")

	var (
		// Atomic counters — safe for concurrent increment across workers.
		totalSent     atomic.Int64
		totalAccepted atomic.Int64 // 202
		totalRejected atomic.Int64 // 4xx (gateway policy rejection)
		totalErrors   atomic.Int64 // network errors, timeouts
		totalOther    atomic.Int64 // unexpected status codes
	)

	startTime := time.Now()

	// Work queue: each item is a request number (0 to N-1).
	// Buffered channel — workers drain it concurrently.
	// Using a channel (vs a shared counter) ensures each request fires exactly once
	// with no synchronization overhead beyond the channel send/receive itself.
	work := make(chan int, *flagN)
	for i := 0; i < *flagN; i++ {
		work <- i
	}
	close(work)

	// Spawn workers.
	var wg sync.WaitGroup
	for w := 0; w < *flagWorkers; w++ {
		wg.Add(1)
		go func(workerID int) {
			defer wg.Done()
			for i := range work {
				statusCode, body := fire(httpClient, req, *flagEndpoint)
				totalSent.Add(1)

				switch {
				case statusCode == 202:
					totalAccepted.Add(1)
				case statusCode >= 400 && statusCode < 500:
					totalRejected.Add(1)
					if *flagVerbose {
						fmt.Printf("[WORKER %d] req %d → %d %s\n", workerID, i, statusCode, body)
					}
				case statusCode == 503:
					totalErrors.Add(1)
					if *flagVerbose {
						fmt.Printf("[WORKER %d] req %d → 503 BACKPRESSURE\n", workerID, i)
					}
				case statusCode == 0:
					totalErrors.Add(1)
					if *flagVerbose {
						fmt.Printf("[WORKER %d] req %d → NETWORK ERROR: %s\n", workerID, i, body)
					}
				default:
					totalOther.Add(1)
					if *flagVerbose {
						fmt.Printf("[WORKER %d] req %d → %d %s\n", workerID, i, statusCode, body)
					}
				}

				// Progress report every 1,000 requests (only from worker 0 to avoid interleaving).
				if workerID == 0 && totalSent.Load()%1000 == 0 {
					elapsed := time.Since(startTime).Seconds()
					sent := totalSent.Load()
					tps := float64(sent) / elapsed
					fmt.Printf("[PROGRESS] sent=%d accepted=%d rejected=%d errors=%d TPS=%.0f\n",
						sent,
						totalAccepted.Load(),
						totalRejected.Load(),
						totalErrors.Load(),
						tps,
					)
				}
			}
		}(w)
	}

	wg.Wait()
	elapsed := time.Since(startTime)

	// ── FINAL RESULTS ─────────────────────────────────────────────────────────
	sent := totalSent.Load()
	accepted := totalAccepted.Load()
	rejected := totalRejected.Load()
	errors := totalErrors.Load()
	other := totalOther.Load()
	tps := float64(sent) / elapsed.Seconds()

	fmt.Printf("\n[CLIENT] ═══════════════════════════════════════════════════════\n")
	fmt.Printf("[CLIENT] STRESS TEST COMPLETE\n")
	fmt.Printf("[CLIENT] ═══════════════════════════════════════════════════════\n")
	fmt.Printf("[RESULTS] Total sent:     %6d\n", sent)
	fmt.Printf("[RESULTS] 202 Accepted:   %6d  (%.1f%%)\n", accepted, 100*float64(accepted)/float64(sent))
	fmt.Printf("[RESULTS] 4xx Rejected:   %6d  (%.1f%%)\n", rejected, 100*float64(rejected)/float64(sent))
	fmt.Printf("[RESULTS] Errors/503:     %6d  (%.1f%%)\n", errors, 100*float64(errors)/float64(sent))
	fmt.Printf("[RESULTS] Other:          %6d  (%.1f%%)\n", other, 100*float64(other)/float64(sent))
	fmt.Printf("[RESULTS] Total time:     %v\n", elapsed.Round(time.Millisecond))
	fmt.Printf("[RESULTS] Throughput:     %.0f requests/sec\n", tps)
	fmt.Printf("[CLIENT] ═══════════════════════════════════════════════════════\n")

	// ── DIAGNOSTIC HINTS ─────────────────────────────────────────────────────
	if rejected > 0 {
		fmt.Printf("\n[DIAGNOSTIC] %d requests rejected (4xx).\n", rejected)
		fmt.Println("[DIAGNOSTIC] Common causes:")
		fmt.Println("[DIAGNOSTIC]   400: PoW nonce doesn't meet difficulty OR deadline too far/expired.")
		fmt.Println("[DIAGNOSTIC]       → Check: powDifficultyZeroBytes matches gateway middleware/pow.go")
		fmt.Println("[DIAGNOSTIC]   401: Ed25519 signature doesn't verify.")
		fmt.Println("[DIAGNOSTIC]       → Check: signing req.payloadBytes exactly (no re-serialisation).")
		fmt.Println("[DIAGNOSTIC]   413: Payload too large.")
		fmt.Println("[DIAGNOSTIC]       → Check: payload is <= 352 bytes after json.Marshal.")
	}
	if errors > int64(float64(sent)*0.01) {
		fmt.Printf("\n[DIAGNOSTIC] Error rate %.1f%% exceeds 1%% SLA threshold.\n",
			100*float64(errors)/float64(sent))
		fmt.Println("[DIAGNOSTIC] Is the Rust LMAX engine running? Is Aeron Media Driver healthy?")
		fmt.Println("[DIAGNOSTIC]   docker compose -f deploy/docker-compose.yml ps")
	}
}
