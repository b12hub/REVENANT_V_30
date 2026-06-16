// =============================================================================
// internal/handler/health.go
// REVENANT Gateway — Health & Readiness Probe Handler
// Classification: RESTRICTED — SOVEREIGN INFRASTRUCTURE
// =============================================================================
//
// PHYSICS RATIONALE:
//
// WHY THE HEALTH HANDLER DOES NOT USE THE POOL:
//
//   The payment handler requires a TransactionEnvelope from the pool because
//   it carries financial state (payload, signature, account IDs) through the
//   pipeline. The health handler carries NO state. Its response is a fixed,
//   pre-determined byte sequence that never changes.
//
//   Using the pool here would be cargo-cult engineering: acquiring and
//   returning a ~5.7KB envelope (with its backing arrays) for a handler
//   that writes a 15-byte response body is wasteful in every sense.
//   The pool exists to amortize the cost of LARGE, frequently-changing
//   objects — not as a blanket pattern for every handler.
//
// LOCK-FREE DESIGN:
//
//   The health handler holds zero mutable state. It reads no global variables,
//   acquires no locks, and calls no functions that do. The Go scheduler never
//   needs to park this goroutine — it runs to completion in nanoseconds.
//
//   This is important for liveness probes: Kubernetes (or the CBU monitoring
//   infrastructure) sends health checks concurrently with live traffic.
//   A health handler that blocks on a mutex would report unhealthy under load —
//   precisely when the health report matters most.
//
// FUTURE EXTENSION — DEEP HEALTH CHECK:
//
//   Sprint 2 will extend HealthHandler with a Deep() method for the
//   /v1/health/deep endpoint, which checks:
//     - Aeron publication connected (subscriber count > 0)
//     - NTP clock drift < 20ms (20ms Suicide Rule pre-flight check)
//     - Pool utilization < 90% (early warning before pool exhaustion)
//   The deep check WILL hold state (the AeronPublisher reference) and
//   will be constructed with NewHealthHandler(publisher) in Sprint 2.
//
// =============================================================================

package handler

import "github.com/valyala/fasthttp"

// =============================================================================
// PRE-ALLOCATED HEALTH RESPONSE
// =============================================================================

var (
	// healthResponseBody is the pre-allocated health check response body.
	// It is a fixed byte sequence — never modified, never nil.
	// fasthttp.RequestCtx.SetBody() copies it to the connection write buffer.
	healthResponseBody = []byte(`{"status":"up"}`)

	// healthContentType is pre-allocated — same pattern as all response types.
	healthContentType = []byte("application/json; charset=utf-8")
)

// =============================================================================
// HEALTH HANDLER
// =============================================================================

// HealthHandler handles GET /v1/health.
//
// It is a pure function in all practical senses: given any RequestCtx,
// it always produces the same response. No state reads, no locks, no pool.
//
// INTENDED CONSUMERS:
//   - Kubernetes liveness probes (determines if the process should be restarted)
//   - Kubernetes readiness probes (determines if traffic should be routed here)
//   - CBU monitoring infrastructure (sovereign uptime reporting)
//   - Load balancer health checks (removes unhealthy instances from rotation)
//
// RESPONSE SEMANTICS:
//
//	HTTP 200 with {"status":"up"} means: the gateway process is alive and
//	the fasthttp server is accepting connections. It does NOT imply that the
//	downstream Aeron cluster is healthy. Use /v1/health/deep for that (Sprint 2).
type HealthHandler struct{}

// NewHealthHandler constructs a HealthHandler.
// Sprint 1: no-arg constructor — no dependencies.
// Sprint 2: will accept *egress.AeronPublisher for deep health checks.
func NewHealthHandler() *HealthHandler {
	return &HealthHandler{}
}

// Handle is the fasthttp.RequestHandler for GET /v1/health.
//
// EXECUTION TRACE:
//
//	ctx.SetStatusCode(200)            ~1ns   (integer write to response struct)
//	ctx.SetContentTypeBytes(...)      ~1ns   (pointer write to response struct)
//	ctx.SetBody(healthResponseBody)   ~5ns   (memmove 15 bytes to conn buffer)
//	─────────────────────────────────────────
//	TOTAL                             ~7ns   0 allocs/op
//
// The health check consumes ~7ns of CPU time and generates zero GC pressure.
// It will NEVER be the bottleneck on a system processing 100,000 TPS.
func (h *HealthHandler) Handle(ctx *fasthttp.RequestCtx) {
	ctx.SetStatusCode(fasthttp.StatusOK) // 200
	ctx.SetContentTypeBytes(healthContentType)
	ctx.SetBody(healthResponseBody)
}
