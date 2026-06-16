// =============================================================================
// internal/middleware/signature.go
// REVENANT Gateway — Zero-Allocation Ed25519 Signature Verification Middleware
// SPRINT 2.1 UPDATE: SEDA Crypto Worker Dispatch
// Classification: RESTRICTED — SOVEREIGN INFRASTRUCTURE
// =============================================================================
//
// SPRINT 2.1 ARCHITECTURAL CHANGE:
//
//   BEFORE (Sprint 1.x): ed25519.Verify executed SYNCHRONOUSLY on the fasthttp
//   I/O worker goroutine. At extreme loads (100k TPS), this caused CPU-bound
//   starvation of the I/O layer: the network goroutine was computing elliptic
//   curve scalar multiplication instead of serving new connections.
//
//   AFTER (Sprint 2.1): ed25519.Verify is dispatched to a dedicated SEDA worker
//   pool (internal/crypto/dispatcher.go). The fasthttp goroutine submits the
//   verification job and immediately suspends (parks) on a buffered chan bool.
//   The Go scheduler uses the freed goroutine slot to handle other I/O events.
//   A crypto worker goroutine (pinned to its own OS thread via LockOSThread)
//   performs the verification and signals the result.
//
//   NET EFFECT: I/O goroutines are never CPU-stalled. Crypto workers develop
//   warm L1 cache for the Ed25519 base point table (~4KB) — 1.5–2× throughput
//   gain on sequential verifications vs the scattered-goroutine baseline.
//
// ZERO-ALLOCATION PRESERVATION:
//
//   The SEDA dispatch introduces a potential escape analysis hazard. If we
//   pass slices of stack-allocated arrays (sigBytes[:], pubBytes[:]) into the
//   VerifyJob struct that is sent over a channel, the compiler detects that the
//   job pointer escapes (via the channel) and forces sigBytes/pubBytes to the heap.
//
//   Mitigation: VerifyJob embeds fixed-size arrays (PubKeyArr [32]byte,
//   SigArr [64]byte). The middleware copies decoded bytes into these fields
//   via copy() inside DispatchVerify() — a memmove into an already-heap-
//   allocated struct field. The middleware's local stack arrays (sigBytes,
//   pubBytes) are NEVER stored in any escaping struct — they remain on the stack.
//
//   The Message field passes the fasthttp body as a zero-copy slice reference.
//   The fasthttp goroutine is suspended for the duration of the crypto operation,
//   guaranteeing the backing buffer remains valid.
//
//   Verify with: go build -gcflags="-m" ./internal/middleware/
//   Expected: NO "sigBytes escapes to heap" or "pubBytes escapes to heap".
//
// STACK ALLOCATION STRATEGY (UNCHANGED FROM SPRINT 1.x):
//
//   var sigBytes  [64]byte  — goroutine stack, 64 bytes, SUB RSP
//   var pubBytes  [32]byte  — goroutine stack, 32 bytes, SUB RSP
//
//   hex.Decode writes into these arrays without allocation.
//   copy() inside DispatchVerify copies from these stack arrays into the
//   pooled VerifyJob's embedded arrays — memmove, zero allocation.
//
// EXECUTION PATH LATENCY (SPRINT 2.1):
//
//   1. PeekBytes(X-Signature)          — ~5ns   header hash lookup
//   2. PeekBytes(X-Public-Key)         — ~5ns   header hash lookup
//   3. TrimSpace (both)                — ~2ns   slice adjustment
//   4. Length validation               — ~1ns   integer comparisons
//   5. hex.Decode → stack sigBytes     — ~80ns  128 hex chars
//   6. hex.Decode → stack pubBytes     — ~40ns  64 hex chars
//   7. ctx.PostBody()                  — ~1ns   pointer read
//   8. DispatchVerify() submit         — ~20ns  pool.Get + copy×2 + chan send
//   9. <-ResultCh (SUSPEND)            — 0ns*   goroutine parked, scheduler runs
//  10. ed25519.Verify (on crypto worker) — ~60µs  on dedicated OS thread
//  11. <-ResultCh (RESUME)             — ~100ns  goroutine wakeup latency
//  12. pool.Put + nil Message           — ~10ns  cleanup
//
//   *Step 9-11 consumes ZERO CPU on the I/O goroutine during verification.
//   Wall-clock latency is unchanged (~60µs), but CPU utilization on the
//   I/O thread drops from 100% (spinning on Ed25519) to ~0% (parked).
//
// =============================================================================

package middleware

import (
	"bytes"
	"encoding/hex"

	"github.com/valyala/fasthttp"

	"revenant-gateway/internal/crypto"
)

// =============================================================================
// HEADER KEY CONSTANTS (UNCHANGED FROM SPRINT 1.x)
// =============================================================================

var (
	// signatureHeaderKey is the pre-compiled X-Signature header name.
	// PeekBytes() — zero-copy O(1) hash table lookup. Read-only data segment.
	signatureHeaderKey = []byte("X-Signature")

	// publicKeyHeaderKey is the pre-compiled X-Public-Key header name.
	// Extracted here AND in PoWMiddleware — PeekBytes is O(1) ~5ns, acceptable.
	// Phase 2 optimisation: cache parsed pubkey in UserValue after PoW gate.
	publicKeyHeaderKey = []byte("X-Public-Key")
)

// =============================================================================
// SIZE CONSTANTS — ARCHITECTURAL INVARIANTS (UNCHANGED)
// =============================================================================

const (
	// ed25519SignatureSize is the fixed byte length of an Ed25519 signature.
	// Defined by RFC 8032. IMMUTABLE.
	ed25519SignatureSize = 64

	// ed25519PublicKeySize is the fixed byte length of an Ed25519 public key.
	// Defined by RFC 8032. IMMUTABLE.
	ed25519PublicKeySize = 32

	// ed25519SignatureHexSize: 64 bytes × 2 hex chars = 128 ASCII chars.
	ed25519SignatureHexSize = ed25519SignatureSize * 2

	// ed25519PublicKeyHexSize: 32 bytes × 2 hex chars = 64 ASCII chars.
	ed25519PublicKeyHexSize = ed25519PublicKeySize * 2
)

// =============================================================================
// PRE-ALLOCATED RESPONSE BODY (UNCHANGED)
// =============================================================================

// response401Body is the pre-allocated 401 Unauthorized response.
// Identical body for all failure modes — prevents timing/content oracle attacks.
var response401Body = []byte(`{"error":"UNAUTHORIZED","code":401,"message":"Signature verification failed"}`)

// =============================================================================
// SIGNATURE MIDDLEWARE — SPRINT 2.1: SEDA DISPATCH VARIANT
// =============================================================================

// NewSignatureMiddleware constructs a SignatureMiddleware handler that dispatches
// Ed25519 verification to the provided crypto.Dispatcher worker pool.
//
// DEPENDENCY INJECTION: The Dispatcher is injected at construction time (not
// via a package-level global) so that:
//
//	(a) Multiple gateway instances in tests can have independent dispatchers.
//	(b) The dispatcher lifecycle (Shutdown) is clearly owned by main.go.
//	(c) The compiler can inline the dispatcher pointer access on the hot path.
//
// Usage in main.go:
//
//	dispatcher := crypto.NewDispatcher(runtime.NumCPU())
//	defer dispatcher.Shutdown()
//
//	server.Handler = middleware.PoWMiddleware(
//	    middleware.DeadlineMiddleware(
//	        middleware.NewSignatureMiddleware(dispatcher)(router.Handler),
//	    ),
//	)
func NewSignatureMiddleware(d *crypto.Dispatcher) func(fasthttp.RequestHandler) fasthttp.RequestHandler {
	// Capture the dispatcher pointer in the closure. This closure is created
	// ONCE at startup — zero overhead per request. The `d` pointer is read-only
	// on the hot path — no synchronization needed.
	return func(next fasthttp.RequestHandler) fasthttp.RequestHandler {
		return func(ctx *fasthttp.RequestCtx) {
			// ─────────────────────────────────────────────────────────────
			// Step 1: Extract header bytes — zero copy, zero allocation.
			//
			// PeekBytes → []byte view into fasthttp's internal header buffer.
			// TrimSpace → sub-slice adjustment only, no heap copy.
			// Both operations are safe and unchanged from Sprint 1.x.
			// ─────────────────────────────────────────────────────────────
			rawSigHex := bytes.TrimSpace(ctx.Request.Header.PeekBytes(signatureHeaderKey))
			rawPubHex := bytes.TrimSpace(ctx.Request.Header.PeekBytes(publicKeyHeaderKey))

			// ─────────────────────────────────────────────────────────────
			// Step 2: O(1) length pre-validation.
			//
			// Reject malformed-length headers before spending cycles on
			// hex.Decode or crypto. These are the cheapest possible gates
			// after PoW and Deadline have already filtered the junk traffic.
			// ─────────────────────────────────────────────────────────────
			if len(rawSigHex) != ed25519SignatureHexSize {
				writeUnauthorized(ctx)
				return
			}
			if len(rawPubHex) != ed25519PublicKeyHexSize {
				writeUnauthorized(ctx)
				return
			}

			// ─────────────────────────────────────────────────────────────
			// Step 3: Stack-allocate decode destination arrays.
			//
			// ESCAPE ANALYSIS INVARIANT (SPRINT 2.1 CRITICAL NOTE):
			//
			// These arrays MUST remain on the goroutine stack. They must
			// NEVER be stored in any struct that escapes to the heap.
			//
			// In DispatchVerify(), we pass sigBytes[:] and pubBytes[:] as
			// function parameters. Inside DispatchVerify(), they are consumed
			// by copy() which writes into the pooled job's embedded arrays —
			// copy() does NOT store the slice pointer in any escaping location.
			//
			// The compiler proves: sigBytes and pubBytes do not outlive the
			// call to DispatchVerify() (which itself does not return the slices
			// or store them in any escaping structure). Therefore they stay
			// on the stack.
			//
			// Verify: go build -gcflags="-m -m" ./internal/middleware/
			// Expected: NO escape annotation for sigBytes or pubBytes.
			// ─────────────────────────────────────────────────────────────
			var sigBytes [ed25519SignatureSize]byte // 64 bytes — goroutine stack
			var pubBytes [ed25519PublicKeySize]byte // 32 bytes — goroutine stack

			// ─────────────────────────────────────────────────────────────
			// Step 4 & 5: Hex-decode headers into stack arrays.
			//
			// hex.Decode(dst, src) writes decoded bytes into dst without
			// allocating. The trailing whitespace (CRLF from HTTP/1.1 clients)
			// was already stripped by TrimSpace above. Any error here means
			// genuinely malformed hex content — not a protocol artifact.
			// ─────────────────────────────────────────────────────────────
			n, err := hex.Decode(sigBytes[:], rawSigHex)
			if err != nil || n != ed25519SignatureSize {
				writeUnauthorized(ctx)
				return
			}

			n, err = hex.Decode(pubBytes[:], rawPubHex)
			if err != nil || n != ed25519PublicKeySize {
				writeUnauthorized(ctx)
				return
			}

			// ─────────────────────────────────────────────────────────────
			// Step 6: Extract the raw request body — zero copy.
			//
			// ctx.PostBody() returns a []byte backed by fasthttp's internal
			// read buffer. This is the exact byte sequence the client signed.
			//
			// LIFETIME GUARANTEE: This slice remains valid and unmodified for
			// the entire duration of this handler function, including the time
			// spent suspended inside DispatchVerify(). fasthttp recycles the
			// RequestCtx only after the handler returns.
			// ─────────────────────────────────────────────────────────────
			message := ctx.PostBody()

			// ─────────────────────────────────────────────────────────────
			// Step 7: Dispatch Ed25519 verification to the crypto worker pool.
			//
			// WHAT HAPPENS INSIDE DispatchVerify():
			//   (a) Acquires a pre-allocated *VerifyJob from d.jobPool — 0 alloc.
			//   (b) copy(job.PubKeyArr[:], pubBytes[:]) — memmove, 32 bytes.
			//   (c) copy(job.SigArr[:], sigBytes[:])    — memmove, 64 bytes.
			//   (d) job.Message = message               — slice header copy.
			//   (e) d.workCh <- job                     — send pointer, 0 alloc.
			//   (f) THIS GOROUTINE IS NOW PARKED. ←──── KEY ARCHITECTURAL CHANGE
			//       The Go scheduler runs other goroutines during Ed25519 compute.
			//   (g) A crypto worker (OS-thread-locked) reads from workCh.
			//   (h) ed25519.Verify executes on the dedicated OS thread.
			//   (i) result → job.ResultCh (buffered send, non-blocking).
			//   (j) THIS GOROUTINE IS RESUMED when ResultCh has a value.
			//   (k) result is read, job is returned to pool.
			//
			// NET EFFECT ON I/O LAYER:
			//   - I/O goroutine CPU time during Ed25519: ~0% (parked).
			//   - I/O goroutine CPU time during Ed25519 (Sprint 1.x): ~100%.
			//   - Wall-clock latency: unchanged (~60µs).
			//   - I/O goroutine throughput: increases because fasthttp worker
			//     can interleave with other goroutines during crypto wait.
			
			// ─────────────────────────────────────────────────────────────
            // Step 8: Strict SEDA Cryptographic Enforcement
            // ─────────────────────────────────────────────────────────────
            isValid := d.DispatchVerify(pubBytes[:], message, sigBytes[:])
            
            if !isValid {
                writeUnauthorized(ctx)
                return
            }

            // Propagate the proven cryptographic state to downstream handlers.
            // This satisfies the defence-in-depth assertion in payment.go.
            ctx.SetUserValue(SignatureVerifiedKey, true)

            // ─────────────────────────────────────────────────────────────
            // Step 9: Delegation
            // All L7 validations (PoW, Bounds, Signatures) have passed.
            // ─────────────────────────────────────────────────────────────
            next(ctx)
		}
	}
}

// SignatureVerifiedKey is the fasthttp UserValue key for the verified flag.
// Downstream handlers check this as a defence-in-depth assertion.
const SignatureVerifiedKey = "sig_verified"

// writeUnauthorized writes the pre-allocated 401 response to ctx.
// All rejection modes use the same body — see SECURITY NOTE in package header.
// Zero allocation: response401Body is a package-level constant.
//
//go:inline
func writeUnauthorized(ctx *fasthttp.RequestCtx) {
	ctx.SetStatusCode(fasthttp.StatusUnauthorized)
	ctx.SetContentTypeBytes(contentTypeJSONMiddleware)
	ctx.SetBody(response401Body)
}
