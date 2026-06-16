// =============================================================================
// internal/router/router.go
// REVENANT Gateway — Radix Tree Router (Sprint 3)
// =============================================================================

package router

import (
	"github.com/valyala/fasthttp"
	"revenant-gateway/internal/handler"
)

// Router maps incoming HTTP requests to their specific domain handlers.
type Router struct {
	paymentHandler *handler.PaymentHandler
}

// New constructs the Router and injects the domain handlers.
func New(payment *handler.PaymentHandler) *Router {
	return &Router{
		paymentHandler: payment,
	}
}

// Handler is the innermost execution layer of the fasthttp pipeline.
func (r *Router) Handler(ctx *fasthttp.RequestCtx) {
	path := ctx.Path()

	// Sprint 3: Route payment commands directly to the Aeron-backed handler.
	// We use exact byte matching for zero-allocation routing.
	if string(path) == "/v1/tx/payment" && ctx.IsPost() {
		r.paymentHandler.Handle(ctx)
		return
	}

	// Fallback for unmapped routes
	ctx.Error("Not Found", fasthttp.StatusNotFound)
}
