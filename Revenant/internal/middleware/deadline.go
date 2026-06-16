// =============================================================================
// internal/middleware/deadline.go
// REVENANT Gateway — Zero-Allocation Deadline Enforcement Middleware
// Classification: RESTRICTED — SOVEREIGN INFRASTRUCTURE
// =============================================================================

package middleware

import (
	"bytes"
	"time"

	"github.com/valyala/fasthttp"
)

const (
	MinRemainingBudgetMs = int64(5)
	MaxDeadlineAheadMs   = int64(30_000)
)

var deadlineHeaderKey = []byte("X-Deadline-Timestamp")

var (
	response408Body           = []byte(`{"error":"DEADLINE_EXCEEDED","code":408,"message":"Request deadline exceeded or remaining budget critically low"}`)
	response400DeadlineBody   = []byte(`{"error":"INVALID_DEADLINE","code":400,"message":"X-Deadline-Timestamp header missing or malformed"}`)
	contentTypeJSONMiddleware = []byte("application/json; charset=utf-8")
)

// DeadlineMiddleware returns a fasthttp.RequestHandler that enforces the
// 200ms SLA drop rule before delegating to the next handler.
func DeadlineMiddleware(next fasthttp.RequestHandler) fasthttp.RequestHandler {
	return func(ctx *fasthttp.RequestCtx) {
		// Step 1: Extract the raw deadline header bytes.
		rawDeadline := ctx.Request.Header.PeekBytes(deadlineHeaderKey)
		if len(rawDeadline) == 0 {
			writeBadDeadline(ctx)
			return
		}

		// Step 2: Parse the raw ASCII bytes into an int64 millisecond timestamp.
		deadlineMs, ok := parseMillisFromBytes(rawDeadline)
		if !ok {
			writeBadDeadline(ctx)
			return
		}

		// Step 3: Get current time as Unix milliseconds.
		nowMs := time.Now().UnixMilli()

		// Step 4: Compute remaining budget.
		remainingMs := deadlineMs - nowMs

		// Step 5: Enforce the drop rule.
		if remainingMs < MinRemainingBudgetMs {
			writeDeadlineExceeded(ctx)
			return
		}
		if deadlineMs > nowMs+MaxDeadlineAheadMs {
			writeBadDeadline(ctx)
			return
		}

		// Step 6: Delegate to next handler. The pipeline may proceed.
		// (NOTE: ctx.SetUserValue was structurally removed to eliminate 8-byte heap allocation)
		next(ctx)
	}
}

// parseMillisFromBytes parses an ASCII decimal integer from a raw byte slice
// into an int64 Unix millisecond timestamp. Uses Horner's method.
func parseMillisFromBytes(b []byte) (int64, bool) {
	// Strip leading/trailing whitespace injected by HTTP/1.1 clients (zero-alloc)
	b = bytes.TrimSpace(b)

	if len(b) == 0 || len(b) > 15 {
		return 0, false
	}

	var result int64
	for _, c := range b {
		if c < '0' || c > '9' {
			return 0, false
		}
		result = result*10 + int64(c-'0')
	}

	if result <= 0 {
		return 0, false
	}

	return result, true
}

//go:inline
func writeDeadlineExceeded(ctx *fasthttp.RequestCtx) {
	ctx.SetStatusCode(fasthttp.StatusRequestTimeout) // 408
	ctx.SetContentTypeBytes(contentTypeJSONMiddleware)
	ctx.SetBody(response408Body)
}

//go:inline
func writeBadDeadline(ctx *fasthttp.RequestCtx) {
	ctx.SetStatusCode(fasthttp.StatusBadRequest) // 400
	ctx.SetContentTypeBytes(contentTypeJSONMiddleware)
	ctx.SetBody(response400DeadlineBody)
}
