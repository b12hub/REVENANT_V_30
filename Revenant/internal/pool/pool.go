// =============================================================================
// internal/pool/pool.go
// REVENANT Gateway — Zero-Allocation Object Pool Registry
// Classification: RESTRICTED — SOVEREIGN INFRASTRUCTURE
// =============================================================================
//
// PHYSICS RATIONALE:
//
// sync.Pool is a GC-aware free-list. Its contract:
//   - pool.Get() returns a previously-returned object if one exists,
//     otherwise calls New() to construct a fresh one.
//   - pool.Put() returns an object to the pool for future reuse.
//   - The GC MAY evict pool entries between GC cycles. This is acceptable:
//     we pay the allocation cost only on GC eviction, not on every request.
//     Under sustained load (100k TPS), the pool stays warm and GC evictions
//     are amortized to near-zero cost per request.
//
// POOL DESIGN PRINCIPLES:
//
//  1. TYPED WRAPPER FUNCTIONS
//     Raw sync.Pool returns interface{} which requires a type assertion.
//     Type assertions are cheap but not free — they call into the runtime.
//     Our typed AcquireEnvelope/ReleaseEnvelope wrappers make the assertion
//     once and give the compiler a concrete type for escape analysis.
//
//  2. MANDATORY RESET-BEFORE-RELEASE DISCIPLINE
//     Every caller MUST call envelope.Reset() BEFORE calling ReleaseEnvelope.
//     The pool does NOT call Reset() internally — that would silently mask
//     bugs where callers forget to reset, allowing data to persist.
//     The bench test mathematically verifies this contract.
//
//  3. FASTJSON PARSER POOL
//     valyala/fastjson.Parser is NOT goroutine-safe. It maintains internal
//     parse state between calls. Each goroutine must hold its own Parser
//     instance. The sync.Pool perfectly models this: one Parser per
//     concurrent goroutine, returned and reused after each request.
//     AcquireParser/ReleaseParser enforce this lifecycle.
//
//  4. RESPONSE BUFFER POOL
//     Pre-allocated []byte response buffers prevent per-response allocations
//     when writing back to the fasthttp connection. The buffer is resliced
//     to length 0 on release (content is overwritten, not sensitive financial
//     data, so zeroing is not required — unlike TransactionEnvelope).
//
// =============================================================================

package pool

import (
	"sync"

	"revenant-gateway/internal/frame"

	"github.com/valyala/fastjson"
)

// =============================================================================
// POOL DECLARATIONS
//
// All pools are package-level variables initialized once at program startup.
// Package-level sync.Pool is safe: the Go runtime guarantees that sync.Pool
// is initialized before any goroutine accesses it.
// =============================================================================

// envelopePool is the central registry for TransactionEnvelope objects.
// New() is called by the runtime only when the pool is cold (startup or
// post-GC eviction). Under sustained 100k TPS load, this path is never hot.
var envelopePool = sync.Pool{
	New: func() interface{} {
		// frame.NewEnvelope() performs the ONLY heap allocation in the
		// entire hot path. It is called once per pool slot, never per request.
		// The resulting envelope is reused indefinitely until GC eviction.
		return frame.NewEnvelope()
	},
}

// parserPool is the central registry for valyala/fastjson.Parser objects.
//
// CRITICAL: fastjson.Parser is stateful and NOT goroutine-safe. The sync.Pool
// ensures at most one goroutine holds a given Parser instance at any time.
// A goroutine that calls AcquireParser owns that Parser exclusively until
// it calls ReleaseParser. Never share a Parser across goroutines.
var parserPool = sync.Pool{
	New: func() interface{} {
		// fastjson.Parser has no configuration — zero-value is valid.
		// The parser pre-allocates internal scratch buffers on first use
		// and reuses them across calls to Parser.Parse(). This is the
		// source of its zero-allocation guarantee for subsequent parses.
		return &fastjson.Parser{}
	},
}

// responseBufferPool is the central registry for pre-allocated response
// write buffers. Cap is 1,024 bytes — sufficient for all gateway responses
// (ACK, NACK, 408 deadline-exceeded, 401 signature-invalid).
//
// Response content is NOT financial data — zeroing is not required.
// The buffer is resliced to len=0 on release; the next caller overwrites it.
var responseBufferPool = sync.Pool{
	New: func() interface{} {
		// Allocate a []byte with length 0 and capacity 1,024.
		// We store *[]byte to avoid a copy when the interface is unwrapped.
		buf := make([]byte, 0, 1024)
		return &buf
	},
}

// =============================================================================
// ENVELOPE POOL API
// =============================================================================

// AcquireEnvelope retrieves a TransactionEnvelope from the pool.
//
// CONTRACT: The caller MUST call envelope.Reset() followed by
// ReleaseEnvelope(envelope) when the request lifecycle completes.
// Failure to release leaks the envelope from the pool, eventually forcing
// the New() constructor to allocate fresh objects under load.
//
// USAGE PATTERN (the only correct pattern):
//
//	env := pool.AcquireEnvelope()
//	defer func() {
//	    env.Reset()
//	    pool.ReleaseEnvelope(env)
//	}()
//	// ... fill and process env ...
func AcquireEnvelope() *frame.TransactionEnvelope {
	// The type assertion here is the ONLY non-inlineable operation.
	// The Go compiler cannot eliminate it, but it costs ~1ns — acceptable.
	return envelopePool.Get().(*frame.TransactionEnvelope)
}

// ReleaseEnvelope returns a TransactionEnvelope to the pool.
//
// PRECONDITION: env.Reset() MUST have been called before ReleaseEnvelope.
// The pool performs no validation — it trusts the caller. This is a
// deliberate design choice: defensive zeroing inside Release would silently
// mask a class of bugs (use-after-release data exposure) that must be caught
// by the benchmark's AllocsPerRun and integration tests, not hidden.
func ReleaseEnvelope(env *frame.TransactionEnvelope) {
	envelopePool.Put(env)
}

// =============================================================================
// PARSER POOL API
// =============================================================================

// AcquireParser retrieves a fastjson.Parser from the pool.
//
// CONTRACT: The caller MUST call ReleaseParser when JSON parsing is complete.
// The Parser must not be used after it is released — the next goroutine to
// acquire it will overwrite its internal state.
//
// USAGE PATTERN:
//
//	p := pool.AcquireParser()
//	defer pool.ReleaseParser(p)
//	v, err := p.ParseBytes(env.Payload)
func AcquireParser() *fastjson.Parser {
	return parserPool.Get().(*fastjson.Parser)
}

// ReleaseParser returns a fastjson.Parser to the pool.
// The Parser's internal arena is retained — it will be reused for the next
// Parse call, avoiding re-allocation of scratch space.
func ReleaseParser(p *fastjson.Parser) {
	parserPool.Put(p)
}

// =============================================================================
// RESPONSE BUFFER POOL API
// =============================================================================

// AcquireResponseBuffer retrieves a pre-allocated response []byte from the pool.
// The returned slice has length 0 and capacity 1,024.
// Callers append response bytes into it and write it directly to the conn.
//
// USAGE PATTERN:
//
//	buf := pool.AcquireResponseBuffer()
//	defer pool.ReleaseResponseBuffer(buf)
//	*buf = append(*buf, responseBytes...)
//	conn.Write(*buf)
func AcquireResponseBuffer() *[]byte {
	return responseBufferPool.Get().(*[]byte)
}

// ReleaseResponseBuffer returns a response buffer to the pool.
// The buffer is resliced to length 0 — content is implicitly discarded.
// Callers must not retain a reference to the buffer after this call.
func ReleaseResponseBuffer(buf *[]byte) {
	// Reslice to len=0, preserving the backing array allocation.
	// This is safe for response data (not sensitive financial content).
	*buf = (*buf)[:0]
	responseBufferPool.Put(buf)
}
