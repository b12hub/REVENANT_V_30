// =============================================================================
// cmd/gateway/main.go
// REVENANT Gateway — Sovereign Entry Point
// PHASE I UPDATE: Armor Restored & Nil Pointers Fixed
// SPRINT 10: CQRS & Automated Failover Active
// =============================================================================

package main

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math"
	"net"
	"os"
	"os/signal"
	"runtime"
	"runtime/debug"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	//     "unsafe"

	"github.com/valyala/fasthttp"
	"github.com/valyala/fastjson"

	"revenant-gateway/internal/crypto"
	"revenant-gateway/internal/firewall"
	"revenant-gateway/internal/icde"
	"revenant-gateway/internal/intent"
	"revenant-gateway/internal/ipc"
	"revenant-gateway/internal/middleware"
	"revenant-gateway/internal/risk"
	"revenant-gateway/internal/routing"
)

type Gateway struct {
	SemanticFirewall *firewall.Firewall
	IntentExtractor  *intent.Extractor
	Resolver         *icde.EntityResolver
	Signer           *icde.IntentSigner

	sequencerMu   sync.RWMutex
	SequencerConn *net.UDPConn

	Registry   *routing.ReturnRegistry
	RiskEngine *risk.Engine
}

var fastPathNonce uint64 = 1000

// adminForgeNonce is the nonce counter for Simulation Forge admin injections.
// Starts at 2,000,000 — well above fastPathNonce's space — so the Rust engine
// never sees a duplicate nonce between the fast-path and admin-forge namespaces.
var adminForgeNonce uint64 = 2_000_000

// Tracks the amount of the last standard transaction for the Clone tool
var lastTxAmount uint64 = 10000 // Default to 10k tiyins (100 UZS) if cloned before any tx

// ringUtilBits stores the latest ring_utilization_pct from the Rust telemetry
// firehose as IEEE 754 float32 bits. Using math.Float32bits / math.Float32frombits
// gives exact float storage in a single uint32 atomic — no precision loss and
// no extra multiplication that would introduce rounding error at the 80.0% threshold.
//
// Initial value is 0 (0.0% utilization) — the gateway accepts all traffic at
// startup and begins shedding only once the first telemetry packet arrives.
var ringUtilBits uint32 // atomic; read via math.Float32frombits(atomic.LoadUint32(&ringUtilBits))

// TelemetryPayload matches the JSON emitted by the Rust execution engine
// every METRICS_INTERVAL (100ms). Fields not yet emitted by the engine
// (ring_utilization_pct, wal_latency_us) will be zero-valued until the
// Rust telemetry format is upgraded to include them.
type TelemetryPayload struct {
	TPS                uint64  `json:"tps"`
	TxTotal            uint64  `json:"tx_total"`
	RingUtilizationPct float32 `json:"ring_utilization_pct"`
	WalLatencyUs       uint64  `json:"wal_latency_us"`
}

func (gw *Gateway) HandleAgenticTransact(ctx *fasthttp.RequestCtx) {
	var p fastjson.Parser
	v, err := p.ParseBytes(ctx.PostBody())
	if err != nil {
		sendJSONError(ctx, fasthttp.StatusBadRequest, "Invalid JSON payload")
		return
	}

	intentBytes := v.GetStringBytes("intent")
	if intentBytes == nil {
		sendJSONError(ctx, fasthttp.StatusBadRequest, "Missing 'intent' field")
		return
	}
	intentStr := string(intentBytes)

	const simulatedUserID icde.UserID = 1055
	const senderAccountID uint32 = 99281

	cleanIntent, err := gw.SemanticFirewall.Sanitize(intentStr)
	if err != nil {
		sendJSONError(ctx, fasthttp.StatusNotAcceptable, "Security Policy Violation: "+err.Error())
		return
	}

	llmCtx, cancel := context.WithTimeout(context.Background(), 100*time.Second)
	defer cancel()

	intentRes, err := gw.IntentExtractor.Extract(llmCtx, cleanIntent)
	if err != nil {
		log.Printf("[EXTRACTOR ERROR] %v", err)
		sendJSONError(ctx, fasthttp.StatusUnprocessableEntity, "Failed to extract clear intent from text")
		return
	}

	var resolvedActions []icde.ResolvedAction
	for _, raw := range intentRes.Actions {
		receiverID, err := gw.Resolver.Resolve(simulatedUserID, raw.ReceiverAlias)
		if err != nil {
			sendJSONError(ctx, fasthttp.StatusConflict, "Ambiguous entity: "+raw.ReceiverAlias)
			return
		}

		resolvedActions = append(resolvedActions, icde.ResolvedAction{
			Action:   icde.ActionType(raw.ActionType),
			Sender:   icde.AccountID(senderAccountID),
			Receiver: receiverID,
			Amount:   raw.Amount * 100, // Convert UZS to tiyins
			Nonce:    uint64(time.Now().UnixNano()),
		})
	}

	intentHash, err := icde.CanonicalizeIntent(resolvedActions)
	if err != nil {
		sendJSONError(ctx, fasthttp.StatusInternalServerError, "Canonicalization fault")
		return
	}

	signature := gw.Signer.Sign(intentHash)

	primaryAction := resolvedActions[0]
	primitives := ipc.TransactionPrimitives{
		Sender:   uint32(primaryAction.Sender),
		Receiver: uint32(primaryAction.Receiver),
		Amount:   primaryAction.Amount,
		Nonce:    primaryAction.Nonce,
		Action:   uint8(primaryAction.Action),
	}

	// Save the amount for the Clone tool
	atomic.StoreUint64(&lastTxAmount, primitives.Amount)

	// ── THE AI RISK SIDECAR ──────────────────────────────────────────
	if err := gw.RiskEngine.Evaluate(primitives.Sender, primitives.Amount); err != nil {
		log.Printf("[RISK ENGINE] 🛑 %v", err)
		sendJSONError(ctx, fasthttp.StatusLocked, err.Error())
		return
	}
	// ─────────────────────────────────────────────────────────────────

	env, err := ipc.PackEnvelope(intentHash, signature, primitives)
	if err != nil {
		sendJSONError(ctx, fasthttp.StatusInternalServerError, "IPC packaging fault")
		return
	}
	defer ipc.ReleaseEnvelope(env)

	promise := make(routing.Promise, 1)
	gw.Registry.RegisterPromise(intentHash, promise)
	defer gw.Registry.RemovePromise(intentHash)

	gw.sequencerMu.RLock()
	_, publishErr := gw.SequencerConn.Write(env[:])
	gw.sequencerMu.RUnlock()

	if publishErr != nil {
		sendJSONError(ctx, fasthttp.StatusBadGateway, "Local Sequencer offline.")
		return
	}

	timer := time.NewTimer(2 * time.Second)
	defer timer.Stop()

	select {
	case execErr := <-promise:
		if execErr == nil {
			go gw.RiskEngine.RecordAsync(primitives.Sender, primitives.Amount)

			ctx.SetStatusCode(fasthttp.StatusOK)
			ctx.SetContentType("application/json")
			ctx.SetBodyString(`{"status":"success","message":"Ledger Mutated"}`)
		} else {
			handleExecutionError(ctx, execErr)
		}
	case <-timer.C:
		sendJSONError(ctx, fasthttp.StatusGatewayTimeout, "Timeout awaiting cluster consensus")
	}
}

func (gw *Gateway) HandleBalanceQuery(ctx *fasthttp.RequestCtx) {
	accountStr := string(ctx.QueryArgs().Peek("account"))
	if accountStr == "" {
		accountStr = "88888"
	}

	// ── CQRS READ PATH: Query the Axum Materialised View ──
	url := "http://127.0.0.1:8084/api/v1/balance/" + accountStr

	req := fasthttp.AcquireRequest()
	defer fasthttp.ReleaseRequest(req)
	req.SetRequestURI(url)

	resp := fasthttp.AcquireResponse()
	defer fasthttp.ReleaseResponse(resp)

	// Execute the HTTP GET to the Rust Query Node
	if err := fasthttp.Do(req, resp); err != nil {
		log.Printf("[CQRS] ERROR: Query Node offline: %v", err)
		ctx.SetStatusCode(fasthttp.StatusServiceUnavailable)
		ctx.SetBodyString(`{"error": "Query Node offline"}`)
		return
	}

	// Proxy the JSON response directly back to the React UI
	ctx.SetContentType("application/json")
	ctx.SetStatusCode(resp.StatusCode())
	ctx.SetBody(resp.Body())
}

func (gw *Gateway) HandleFastPathTransact(ctx *fasthttp.RequestCtx) {
	primitives := ipc.TransactionPrimitives{
		Sender:   99281,
		Receiver: 88888,
		Amount:   1,
		Nonce:    atomic.AddUint64(&fastPathNonce, 1),
		Action:   0,
	}

	dummyActions := []icde.ResolvedAction{{
		Action:   icde.ActionType(primitives.Action),
		Sender:   icde.AccountID(primitives.Sender),
		Receiver: icde.AccountID(primitives.Receiver),
		Amount:   primitives.Amount,
		Nonce:    primitives.Nonce,
	}}

	intentHash, _ := icde.CanonicalizeIntent(dummyActions)
	signature := gw.Signer.Sign(intentHash)

	env, err := ipc.PackEnvelope(intentHash, signature, primitives)
	if err != nil {
		ctx.SetStatusCode(fasthttp.StatusInternalServerError)
		return
	}
	defer ipc.ReleaseEnvelope(env)

	gw.sequencerMu.RLock()
	_, publishErr := gw.SequencerConn.Write(env[:])
	gw.sequencerMu.RUnlock()

	if publishErr != nil {
		ctx.SetStatusCode(fasthttp.StatusServiceUnavailable)
		return
	}

	ctx.SetStatusCode(fasthttp.StatusAccepted)
}

// ── SIMULATION FORGE HANDLERS ─────────────────────────────────────────────

func (gw *Gateway) HandleAdminInject(ctx *fasthttp.RequestCtx) {
	const (
		injectSender   uint32 = 0             // genesis account
		injectReceiver uint32 = 99281         // target: "my" demo account
		injectAmount   uint64 = 1_000_000_000 // 10,000,000 UZS × 100 tiyin/UZS
	)

	primitives := ipc.TransactionPrimitives{
		Sender:   injectSender,
		Receiver: injectReceiver,
		Amount:   injectAmount,
		Nonce:    atomic.AddUint64(&adminForgeNonce, 1),
		Action:   0,
	}

	dummyActions := []icde.ResolvedAction{{
		Action:   icde.ActionType(primitives.Action),
		Sender:   icde.AccountID(primitives.Sender),
		Receiver: icde.AccountID(primitives.Receiver),
		Amount:   primitives.Amount,
		Nonce:    primitives.Nonce,
	}}

	intentHash, err := icde.CanonicalizeIntent(dummyActions)
	if err != nil {
		sendJSONError(ctx, fasthttp.StatusInternalServerError, "Admin inject: canonicalization fault")
		return
	}

	signature := gw.Signer.Sign(intentHash)

	env, err := ipc.PackEnvelope(intentHash, signature, primitives)
	if err != nil {
		sendJSONError(ctx, fasthttp.StatusInternalServerError, "Admin inject: IPC packaging fault")
		return
	}
	defer ipc.ReleaseEnvelope(env)

	gw.sequencerMu.RLock()
	_, publishErr := gw.SequencerConn.Write(env[:])
	gw.sequencerMu.RUnlock()

	if publishErr != nil {
		sendJSONError(ctx, fasthttp.StatusBadGateway, "Admin inject: Sequencer offline")
		return
	}

	log.Printf("[FORGE] INJECT: +1,000,000,000 tiyin → account %d (nonce=%d)", injectReceiver, primitives.Nonce)

	ctx.SetStatusCode(fasthttp.StatusOK)
	ctx.SetContentType("application/json")
	ctx.SetBodyString(`{"status":"success","message":"10M UZS injected into account 99281 via ring buffer"}`)
}

func (gw *Gateway) HandleAdminClone(ctx *fasthttp.RequestCtx) {
	const (
		cloneSender   uint32 = 99281
		cloneReceiver uint32 = 88888
		cloneCount           = 100
	)

	// ── LOAD THE DYNAMIC AMOUNT ──
	dynamicCloneAmount := atomic.LoadUint64(&lastTxAmount)

	var published, failed int

	for i := 0; i < cloneCount; i++ {
		primitives := ipc.TransactionPrimitives{
			Sender:   cloneSender,
			Receiver: cloneReceiver,
			Amount:   dynamicCloneAmount,
			Nonce:    uint64(time.Now().UnixNano()) + uint64(i),
			Action:   0,
		}

		dummyActions := []icde.ResolvedAction{{
			Action:   icde.ActionType(primitives.Action),
			Sender:   icde.AccountID(primitives.Sender),
			Receiver: icde.AccountID(primitives.Receiver),
			Amount:   primitives.Amount,
			Nonce:    primitives.Nonce,
		}}

		intentHash, err := icde.CanonicalizeIntent(dummyActions)
		if err != nil {
			failed++
			continue
		}

		signature := gw.Signer.Sign(intentHash)

		env, err := ipc.PackEnvelope(intentHash, signature, primitives)
		if err != nil {
			failed++
			continue
		}

		gw.sequencerMu.RLock()
		_, pubErr := gw.SequencerConn.Write(env[:])
		gw.sequencerMu.RUnlock()

		if pubErr != nil {
			ipc.ReleaseEnvelope(env)
			failed++
			continue
		}

		ipc.ReleaseEnvelope(env)
		published++
	}

	log.Printf("[FORGE] CLONE: published=%d failed=%d (99281→88888, %d tiyin each)", published, failed, dynamicCloneAmount)

	ctx.SetStatusCode(fasthttp.StatusOK)
	ctx.SetContentType("application/json")
	ctx.SetBodyString(fmt.Sprintf(
		`{"status":"success","message":"%d transactions of %d tiyins published to ring buffer","published":%d,"failed":%d}`,
		published, dynamicCloneAmount, published, failed,
	))
}

func (gw *Gateway) HandleAdminLatency(ctx *fasthttp.RequestCtx) {
	const stallDuration = 2 * time.Second
	log.Printf("[FORGE] LATENCY: stalling for %s — testing React timeout handling", stallDuration)
	time.Sleep(stallDuration)
	log.Printf("[FORGE] LATENCY: stall complete")

	ctx.SetStatusCode(fasthttp.StatusOK)
	ctx.SetContentType("application/json")
	ctx.SetBodyString(`{"status":"success","message":"2s stall complete — UI remained responsive"}`)
}

// PredictiveBackpressure is a fasthttp middleware that reads the latest
// ring buffer utilization reported by the Rust execution engine and sheds
// incoming HTTP load before it reaches the LMAX Disruptor.
//
// At >80% ring utilization the engine is within ~1,638 free slots of a full
// ring (RING_SIZE=8192). At 100k TPS that margin is consumed in ~16ms —
// insufficient headroom to absorb a burst. Shedding at the gateway prevents
// backpressure from stalling the Aeron publisher and causing the entire
// request pipeline to block while waiting for ring slots.
//
// Rejected requests receive HTTP 503 with a JSON body. The CORS headers are
// applied by the outer corsMiddleware layer — this function does not need to
// set them because PredictiveBackpressure sits inside corsMiddleware in the
// pipeline: CORS → PredictiveBackpressure → secureRouter.
//
// The check is a single atomic load + float comparison: ~2ns on amd64.
// There is zero contention between the HTTP request goroutines (all read-only)
// and the UDP listener goroutine (sole writer).
func PredictiveBackpressure(next fasthttp.RequestHandler) fasthttp.RequestHandler {
	const (
		loadSheddingThreshold = float32(80.0)
		responseBody          = `{"status":"error","message":"Execution engine at capacity. Shedding load."}`
	)

	return func(ctx *fasthttp.RequestCtx) {
		util := math.Float32frombits(atomic.LoadUint32(&ringUtilBits))

		if util > loadSheddingThreshold {
			ctx.SetStatusCode(fasthttp.StatusServiceUnavailable)
			ctx.SetContentType("application/json")
			ctx.SetBodyString(responseBody)
			return
		}

		next(ctx)
	}
}

func sendJSONError(ctx *fasthttp.RequestCtx, status int, msg string) {
	ctx.SetStatusCode(status)
	ctx.SetContentType("application/json")
	ctx.SetBodyString(`{"status":"error","message":"` + msg + `"}`)
}

func handleExecutionError(ctx *fasthttp.RequestCtx, err error) {
	switch {
	case errors.Is(err, routing.ErrInsufficientFunds):
		sendJSONError(ctx, fasthttp.StatusBadRequest, "Insufficient funds")
	case errors.Is(err, routing.ErrAccountBlocked):
		sendJSONError(ctx, fasthttp.StatusForbidden, "Account is blocked")
	default:
		sendJSONError(ctx, fasthttp.StatusInternalServerError, "Internal ledger fault")
	}
}

func main() {
	numCPU := runtime.NumCPU()
	runtime.GOMAXPROCS(numCPU)
	debug.SetGCPercent(-1)

	log.Printf("[RUNTIME] GOMAXPROCS=%d | GCPercent=-1 (GC SUSPENDED)", numCPU)

	numCryptoWorkers := numCPU
	dispatcher := crypto.NewDispatcher(numCryptoWorkers)
	defer dispatcher.Shutdown()

	// Initialize UDP connection to the Sequencer
	sequencerAddr, _ := net.ResolveUDPAddr("udp", "127.0.0.1:40122")
	seqConn, err := net.DialUDP("udp", nil, sequencerAddr)
	if err != nil {
		log.Fatalf("[FATAL] Cannot connect to Sequencer: %v", err)
	}
	defer seqConn.Close()

	testPrivateKey := ed25519.PrivateKey{
		255, 100, 250, 114, 19, 167, 98, 227, 111, 137, 207, 32, 1, 88, 83, 165,
		117, 62, 181, 90, 183, 75, 100, 17, 51, 158, 187, 170, 62, 30, 190, 89,
		3, 138, 224, 15, 18, 254, 157, 147, 216, 121, 41, 32, 199, 13, 11, 5,
		125, 251, 24, 102, 203, 228, 250, 172, 138, 251, 228, 225, 24, 77, 197, 216}

	signer, err := icde.NewIntentSigner(testPrivateKey)
	if err != nil {
		log.Fatalf("[FATAL] Failed to initialize IntentSigner: %v", err)
	}

	gw := &Gateway{
		SemanticFirewall: firewall.New(firewall.DefaultConfig()),
		IntentExtractor:  intent.New(intent.DefaultConfig()),
		Resolver:         icde.NewEntityResolver(),
		Signer:           signer,
		SequencerConn:    seqConn,
		Registry:         routing.NewReturnRegistry(),
		RiskEngine:       risk.NewEngine(),
	}

	gw.Registry.StartUDPListener("127.0.0.1:8081")

	// ── RING BUFFER UTILIZATION LISTENER ──────────────────────────────────
	// Listens to the Rust telemetry just to power PredictiveBackpressure
	go func() {
		conn, err := net.ListenPacket("udp", "127.0.0.1:8084")
		if err != nil {
			log.Fatalf("[TELEMETRY] FATAL: cannot bind UDP 127.0.0.1:8084: %v", err)
		}
		defer conn.Close()

		log.Printf("[TELEMETRY] Backpressure monitor active on UDP 127.0.0.1:8084")

		buf := make([]byte, 1024)
		var payload TelemetryPayload

		for {
			n, _, err := conn.ReadFrom(buf)
			if err != nil {
				continue
			}
			if err := json.Unmarshal(buf[:n], &payload); err == nil {
				atomic.StoreUint32(&ringUtilBits, math.Float32bits(payload.RingUtilizationPct))
			}
		}
	}()

	// ?? HEARTBEAT MONITOR & FAILOVER ??

	go func() {
		const (
			heartbeatURL      = "http://127.0.0.1:8084/api/v1/balance/0"
			heartbeatInterval = 1 * time.Second
			failoverThreshold = 3
			euSequencerAddr   = "127.0.0.1:40126" // EU Sequencer Ingress Port
		)

		client := &fasthttp.Client{ReadTimeout: 500 * time.Millisecond}
		var consecutiveFails int
		var failoverTriggered uint32

		for {
			time.Sleep(heartbeatInterval)
			statusCode, _, err := client.Get(nil, heartbeatURL)

			if err != nil || statusCode >= 500 {
				consecutiveFails++
				log.Printf("[HEARTBEAT] Primary Query Node unhealthy (%d/%d): %v", consecutiveFails, failoverThreshold, err)
			} else {
				if consecutiveFails > 0 {
					log.Printf("[HEARTBEAT] Primary recovered.")
				}
				consecutiveFails = 0
				continue
			}

			if consecutiveFails >= failoverThreshold {
				if atomic.CompareAndSwapUint32(&failoverTriggered, 0, 1) {
					log.Printf("════════════════════════════════════════════════════════════")
					log.Printf("[FAILOVER] *** PRIMARY NODE LOST. PROMOTING EU FOLLOWER ***")
					log.Printf("════════════════════════════════════════════════════════════")

					// Connect to EU Sequencer
					euAddr, _ := net.ResolveUDPAddr("udp", euSequencerAddr)
					euSeqConn, euErr := net.DialUDP("udp", nil, euAddr)
					if euErr != nil {
						log.Printf("[FAILOVER] CRITICAL: Cannot reach EU Sequencer either: %v", euErr)
						atomic.StoreUint32(&failoverTriggered, 0)
						consecutiveFails = 0
						continue
					}

					// Swap the Pointer!
					gw.sequencerMu.Lock()
					oldConn := gw.SequencerConn
					gw.SequencerConn = euSeqConn
					gw.sequencerMu.Unlock()

					if oldConn != nil {
						oldConn.Close()
					}

					log.Printf("[FAILOVER] Traffic successfully rerouted to EU Sequencer.")
				}
			}
		}
	}()

	requestHandler := func(ctx *fasthttp.RequestCtx) {
		switch string(ctx.Path()) {
		case "/api/v1/agentic/transact":
			if ctx.IsPost() {
				gw.HandleAgenticTransact(ctx)
			} else {
				ctx.Error("Method not allowed", fasthttp.StatusMethodNotAllowed)
			}
		case "/api/v1/balance":
			if ctx.IsGet() {
				gw.HandleBalanceQuery(ctx)
			}
		case "/v1/tx/payment":
			if ctx.IsPost() {
				gw.HandleFastPathTransact(ctx)
			} else {
				ctx.Error("Method not allowed", fasthttp.StatusMethodNotAllowed)
			}
		case "/api/v1/admin/inject":
			if ctx.IsPost() {
				gw.HandleAdminInject(ctx)
			} else {
				ctx.Error("Method not allowed", fasthttp.StatusMethodNotAllowed)
			}
		case "/api/v1/admin/clone":
			if ctx.IsPost() {
				gw.HandleAdminClone(ctx)
			} else {
				ctx.Error("Method not allowed", fasthttp.StatusMethodNotAllowed)
			}

		case "/api/v1/admin/latency":
			if ctx.IsPost() {
				gw.HandleAdminLatency(ctx)
			} else {
				ctx.Error("Method not allowed", fasthttp.StatusMethodNotAllowed)
			}
		default:
			ctx.Error("Not found", fasthttp.StatusNotFound)
		}
	}

	corsMiddleware := func(next fasthttp.RequestHandler) fasthttp.RequestHandler {
		return func(ctx *fasthttp.RequestCtx) {
			ctx.Response.Header.Set("Access-Control-Allow-Origin", "*")
			ctx.Response.Header.Set("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
			ctx.Response.Header.Set("Access-Control-Allow-Headers", "Content-Type, X-Public-Key, X-Signature, X-Nonce, X-Deadline-Timestamp, X-PoW-Hash")

			if string(ctx.Method()) == "OPTIONS" {
				ctx.SetStatusCode(fasthttp.StatusOK)
				return
			}
			next(ctx)
		}
	}

	signatureMiddleware := middleware.NewSignatureMiddleware(dispatcher)

	secureRouter := func(ctx *fasthttp.RequestCtx) {
		path := string(ctx.Path())
		if path == "/api/v1/balance" ||
			path == "/v1/tx/payment" ||
			strings.HasPrefix(path, "/api/v1/admin/") {
			requestHandler(ctx)
		} else {
			signatureMiddleware(requestHandler)(ctx)
		}
	}

	// Pipeline order: CORS first (handles OPTIONS preflight before any check),
	// then PredictiveBackpressure (sheds load at >80% ring utilization),
	// then secureRouter (signature verification and handler dispatch).
	//
	// Placing PredictiveBackpressure inside corsMiddleware ensures that 503
	// responses include Access-Control-Allow-Origin headers, preventing CORS
	// errors in the React dashboard when the engine is under pressure.
	pipeline := corsMiddleware(PredictiveBackpressure(secureRouter))

	server := &fasthttp.Server{
		Handler:                       pipeline,
		Name:                          "REVENANT-GW/4.0",
		Concurrency:                   numCPU * 1024,
		ReadTimeout:                   5 * time.Second,
		WriteTimeout:                  300 * time.Millisecond,
		IdleTimeout:                   30 * time.Second,
		DisableHeaderNamesNormalizing: true,
		MaxRequestBodySize:            8 * 1024,
		Logger:                        log.Default(),
	}

	const listenAddr = ":8080"
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)

	serverErr := make(chan error, 1)
	go func() {
		log.Printf("[SERVER] REVENANT Apex Gateway listening on %s", listenAddr)
		if err := server.ListenAndServe(listenAddr); err != nil {
			serverErr <- err
		}
	}()

	select {
	case sig := <-sigCh:
		log.Printf("[SERVER] Signal received: %s — initiating graceful shutdown", sig)
		if err := server.Shutdown(); err != nil {
			log.Printf("[SERVER] Shutdown error: %v", err)
			os.Exit(1)
		}
	case err := <-serverErr:
		log.Printf("[SERVER] FATAL: ListenAndServe failed: %v", err)
		os.Exit(1)
	}
}
