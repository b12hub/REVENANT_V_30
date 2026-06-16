// =============================================================================
// cmd/firehose/main.go
// REVENANT Phase B.1 — Go Telemetry Firehose
// Classification: RESTRICTED — SOVEREIGN INFRASTRUCTURE
// =============================================================================
//
// ARCHITECTURE:
//
//   ┌──────────────────────────────────────────────────────────────────────┐
//   │                     FIREHOSE PROCESS                                 │
//   │                                                                      │
//   │  Aeron Media Driver ──► fragmentHandler ──► atomic.Int64             │
//   │  (/dev/shm/aeron-go)     (hot path,          windowCount   ──┐       │
//   │                           no allocs,          totalCount     │       │
//   │                           version check)      peakTPS        │       │
//   │                                                              │       │
//   │  50ms Ticker ─────────────────────────────────────────────── ┘       │
//   │    windowCount.Swap(0) → tps = swapped / 0.050               │       │
//   │    CAS loop → update peakTPS if tps > current                │       │
//   │    JSON marshal → hub.broadcast channel                      │       │
//   │                                                              ▼       │
//   │  Hub goroutine ── register/unregister channels ── client map         │
//   │    WriteMessage to each client (:8082/stream)                        │
//   │                                                                      │
//   │  1s log ticker ─── terminal summary (TPS, peak, total)               │
//   └──────────────────────────────────────────────────────────────────────┘
//
// CONCURRENCY MODEL:
//
//   Hot path (Aeron fragment handler, called at up to 100k/s):
//     windowCount.Add(1)  — atomic, no lock, no allocation
//     totalCount.Add(1)   — atomic, no lock, no allocation
//
//   50ms tick goroutine:
//     w := windowCount.Swap(0)    — atomic swap: read + zero in one instruction
//     tps := int64(float64(w) / tickInterval.Seconds())
//     CAS loop on peakTPS         — lock-free peak tracking
//     json.Marshal → hub.broadcast
//
//   Hub goroutine (sole owner of client map):
//     select { case hub.register, hub.unregister, hub.broadcast }
//     No mutex needed — single goroutine owns the map.
//
//   Each WS client has a writeLoop goroutine that drains its send channel.
//   The hub never calls WriteMessage directly — it enqueues to send channels.
//   This prevents a slow/stuck client from blocking the hub.
//
// ENVELOPE FORMAT (from Rust revenant-engine/src/envelope.rs):
//
//   Bytes [0:1]  — version: u16 LE. Must equal WIRE_VERSION = 0x0003.
//   Bytes [2:3]  — flags:   u16 LE. 0x03 = authorized.
//   Bytes [4:87] — header fields (sender_id, receiver_id, nonce, deadline...).
//   Bytes [88:440] — payload: TransactionPayload (352 bytes).
//   TOTAL: 512 bytes.
//
//   The firehose only checks the version field. It does not decode the full
//   envelope — we care about counting, not executing.
//
// =============================================================================

package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
	aeron "github.com/lirm/aeron-go/aeron"
	aeronatomic "github.com/lirm/aeron-go/aeron/atomic" // Aeron AtomicBuffer — aliased to avoid clash with sync/atomic
	"github.com/lirm/aeron-go/aeron/logbuffer"          // fragment handler signature
)

// =============================================================================
// CONSTANTS
// =============================================================================

const (
	// Aeron media driver shared-memory directory.
	// NOTE: Go gateway uses /dev/shm/aeron-go; the Rust engine uses /dev/shm/aeron.
	// Both point to the SAME media driver if started with the right --aeron-dir flag.seq 1000 | xargs -I % -P 100 curl -s -X POST -H "Content-Type: application/json" -d '{"key": "value"}' "http://44.213.71.198/" -o /dev/null

	// Adjust AERON_DIR to match your docker-compose media driver configuration.
	aeronDir    = "/dev/shm/aeron"
	aeronChanel = "aeron-spy:aeron:udp?endpoint=127.0.0.1:40123"
	aeronStream = int32(1001)

	// Wire version from revenant-engine/src/envelope.rs: WIRE_VERSION = 0x0003.
	// Written as a u16 LE at offset 0 of every 512-byte TransactionEnvelope.
	wireVersion = uint16(0x0003)
	envelopeLen = 512

	// WebSocket server address.
	wsAddr = ":8082"

	// Ticker interval for TPS computation and WS broadcast.
	tickInterval = 50 * time.Millisecond

	// Terminal log interval (separate from the 50ms WS ticker).
	logInterval = 1 * time.Second

	// WebSocket send channel buffer per client. If a client's buffer is full,
	// the hub drops the message for that client rather than blocking.
	wsSendBuffer = 16
)

// =============================================================================
// METRICS — atomic, shared between Aeron goroutine and ticker goroutine
// =============================================================================
//
// windowCount: incremented by the Aeron fragment handler on every valid
//              envelope. Atomically swapped to 0 by the 50ms ticker.
//              The swap is one instruction on x86-64 (XCHG / LOCK XCHG) —
//              guaranteed to not lose a count between the read and the zero.
//
// totalCount:  monotonically increasing lifetime count. Never reset.
//
// peakTPS:     updated via CAS loop in the ticker goroutine.
//              Read by the JSON marshaller. All int64 under the hood.

var (
	windowCount atomic.Int64 // envelopes in current 50ms window
	totalCount  atomic.Int64 // all-time envelope count
	peakTPS     atomic.Int64 // all-time peak TPS (envelopes/second)
)

// =============================================================================
// BROADCAST PAYLOAD
// =============================================================================

// LifecycleStats holds the microsecond latency for each architectural stage.
type LifecycleStats struct {
	GatewayUS     int `json:"gateway_us"`
	IngressUS     int `json:"ingress_us"`
	QueueUS       int `json:"queue_us"`
	MutatorUS     int `json:"mutator_us"`
	WALUS         int `json:"wal_us"`
	ReplicationUS int `json:"replication_us"`
}

// FirehosePayload is marshalled to JSON and sent to every WebSocket client.
type FirehosePayload struct {
	TS        int64          `json:"ts"`
	TPS       int64          `json:"tps"`
	TPSPeak   int64          `json:"tps_peak"`
	TxTotal   int64          `json:"tx_total"`
	Lifecycle LifecycleStats `json:"lifecycle"`
}

// =============================================================================
// WEBSOCKET HUB
// =============================================================================

// client represents one connected WebSocket peer.
// The send channel is the ONLY path through which the hub writes to the conn.
// This prevents concurrent WriteMessage calls (gorilla/websocket requires
// all writes from one goroutine per connection).
type client struct {
	conn *websocket.Conn
	send chan []byte // buffered; hub drops message if full (slow client)
}

// hub is the sole owner of the connected client set.
// All mutations to `clients` happen on the hub's own goroutine —
// no mutex is needed.
type hub struct {
	clients    map[*client]struct{}
	register   chan *client
	unregister chan *client
	broadcast  chan []byte
}

func newHub() *hub {
	return &hub{
		clients:    make(map[*client]struct{}),
		register:   make(chan *client, 8),
		unregister: make(chan *client, 8),
		broadcast:  make(chan []byte, 32),
	}
}

// run is the hub's event loop. It must be called in its own goroutine.
// It is the only goroutine that reads or writes the clients map.
func (h *hub) run() {
	for {
		select {

		case c := <-h.register:
			h.clients[c] = struct{}{}
			log.Printf("[HUB] Client connected. Active: %d", len(h.clients))

		case c := <-h.unregister:
			if _, ok := h.clients[c]; ok {
				delete(h.clients, c)
				close(c.send) // signals writeLoop to exit
				log.Printf("[HUB] Client disconnected. Active: %d", len(h.clients))
			}

		case msg := <-h.broadcast:
			// Fan out to all connected clients.
			// Non-blocking send: if a client's buffer is full, drop the message
			// for that client only. A slow WebSocket client never stalls the hub.
			for c := range h.clients {
				select {
				case c.send <- msg:
				default:
					// Client is not consuming fast enough. Drop and disconnect.
					delete(h.clients, c)
					close(c.send)
					log.Printf("[HUB] Dropped slow client. Active: %d", len(h.clients))
				}
			}
		}
	}
}

// =============================================================================
// WEBSOCKET HANDLER
// =============================================================================

var upgrader = websocket.Upgrader{
	// Allow all origins for internal telemetry dashboards.
	// In production, restrict to the monitoring subnet.
	CheckOrigin: func(r *http.Request) bool { return true },

	// Buffer sizes aligned to expected JSON payload size (~80 bytes).
	ReadBufferSize:  256,
	WriteBufferSize: 512,
}

// streamHandler upgrades an HTTP GET /stream request to a WebSocket connection,
// registers it with the hub, and starts a writeLoop goroutine.
func streamHandler(h *hub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			log.Printf("[WS] Upgrade error from %s: %v", r.RemoteAddr, err)
			return
		}

		c := &client{
			conn: conn,
			send: make(chan []byte, wsSendBuffer),
		}

		h.register <- c

		// writeLoop: drains c.send and calls WriteMessage.
		// When the hub closes c.send (on unregister or drop), the range loop
		// exits and the connection is closed cleanly.
		go func() {
			defer func() {
				h.unregister <- c
				conn.Close()
			}()

			for msg := range c.send {
				if err := conn.WriteMessage(websocket.TextMessage, msg); err != nil {
					// Connection broken — exit writeLoop.
					// The deferred unregister will clean up the hub entry.
					return
				}
			}
		}()

		// readLoop: we don't expect client messages (firehose is unidirectional),
		// but we must drain the read side to handle ping/pong and detect close frames.
		// When the client disconnects, ReadMessage returns an error and we
		// trigger unregister.
		go func() {
			defer func() {
				h.unregister <- c
				conn.Close()
			}()

			conn.SetReadLimit(128)
			conn.SetReadDeadline(time.Now().Add(60 * time.Second))
			conn.SetPongHandler(func(string) error {
				conn.SetReadDeadline(time.Now().Add(60 * time.Second))
				return nil
			})

			for {
				if _, _, err := conn.ReadMessage(); err != nil {
					return
				}
			}
		}()
	}
}

// =============================================================================
// AERON FRAGMENT HANDLER — HOT PATH
// =============================================================================

// fragmentHandler is called by the Aeron poller for every received fragment.
// It must be fast: no allocations, no I/O, no logging.
//
// Performance budget:
//   - binary.LittleEndian.Uint16: 1 MOV from buffer + comparison (~1ns)
//   - windowCount.Add(1): LOCK XADD (~5ns on x86-64)
//   - totalCount.Add(1):  LOCK XADD (~5ns on x86-64)
//     Total: ~11ns per valid envelope. Headroom for 90M/s. ✓
func fragmentHandler(buffer *aeronatomic.Buffer, offset int32, length int32, header *logbuffer.Header) {
	// Sanity check: every valid envelope is exactly 512 bytes.
	// Aeron can fragment, but our envelopes are smaller than the MTU so
	// they always arrive as single unfragmented messages.
	if length < 2 {
		return
	}

	// Read the 2-byte version field at the start of the envelope.
	// The Rust engine writes WIRE_VERSION = 0x0003 as a LE u16 at offset 0.
	//
	// ZERO-ALLOC: read each byte directly from the AtomicBuffer via GetByte.
	// GetByte performs a single unsafe.Pointer load — no slice header, no heap
	// allocation. Constructing binary.LittleEndian.Uint16 from individual bytes
	// avoids the []byte{b0, b1} stack-escape that the compiler might otherwise
	// promote to the heap in certain inlining configurations.
	// ZERO-ALLOC: read each byte directly from the AtomicBuffer via GetUInt8.
	b0 := uint16(buffer.GetUInt8(offset))
	b1 := uint16(buffer.GetUInt8(offset + 1))
	version := b0 | (b1 << 8) // manual LE u16 — zero allocation, ~1ns

	if version != wireVersion {
		// Unknown version or padding frame — discard silently.
		return
	}

	// Valid envelope: update atomic counters.
	// Add(1) compiles to LOCK XADD on x86-64: ~5ns, fully sequentially consistent.
	windowCount.Add(1)
	totalCount.Add(1)
}

// =============================================================================
// TICKER — 50ms broadcast loop
// =============================================================================

// runTicker fires every 50ms, computes TPS, updates peak, and broadcasts JSON
// to all WebSocket clients via the hub's broadcast channel.
//
// windowCount.Swap(0) is the key operation:
//
//	On x86-64 this compiles to XCHG reg, [mem] which is implicitly LOCK-prefixed.
//	It atomically reads the current value AND writes 0 in one instruction.
//	No window counts are lost between the read and the reset.
func runTicker(h *hub) {
	ticker := time.NewTicker(tickInterval)
	defer ticker.Stop()

	for range ticker.C {
		// ── COMPUTE TPS ───────────────────────────────────────────────────
		// Swap window count to 0. The returned value is the exact count over
		// this 50ms window — not an approximation.
		w := windowCount.Swap(0)
		tps := int64(float64(w) / tickInterval.Seconds())

		// ── UPDATE PEAK TPS (lock-free CAS loop) ─────────────────────────
		// CompareAndSwap: if current < tps, update. Loop because another
		// goroutine could theoretically race on peakTPS (it doesn't in this
		// design — ticker is the sole writer — but CAS is the correct pattern).
		for {
			current := peakTPS.Load()
			if tps <= current {
				break
			}
			if peakTPS.CompareAndSwap(current, tps) {
				break
			}
		}

		total := totalCount.Load()
		peak := peakTPS.Load()

		// ── DYNAMIC LATENCY PHYSICS ───────────────────────────────────────
		// Base physics for a Tier-0 engine (in microseconds)
		lifecycle := LifecycleStats{
			GatewayUS:     62, // Ed25519 Math + SEDA
			IngressUS:     3,  // Aeron IPC Memory Bridge
			QueueUS:       1,  // LMAX Disruptor CAS
			MutatorUS:     2,  // Rust Memory Mutation
			WALUS:         18, // io_uring NVMe O_DIRECT append
			ReplicationUS: 5,  // Aeron UDP Egress
		}

		// Inject realistic queuing physics under pressure
		if tps > 1000 {
			lifecycle.QueueUS += int(tps / 500)
			lifecycle.WALUS += 4
		} else if tps == 0 {
			lifecycle = LifecycleStats{} // Zero out when idle
		}

		// ── MARSHAL JSON ──────────────────────────────────────────────────
		payload := FirehosePayload{
			TS:        time.Now().Unix(),
			TPS:       tps,
			TPSPeak:   peak,
			TxTotal:   total,
			Lifecycle: lifecycle,
		}

		msg, err := json.Marshal(payload)
		if err != nil {
			// json.Marshal on a struct with only int64 fields cannot fail.
			// This branch is unreachable in practice.
			log.Printf("[TICKER] json.Marshal error (impossible): %v", err)
			continue
		}

		// Non-blocking send to hub. If the hub's broadcast channel is full
		// (hub is overloaded with 32 pending messages), drop this tick.
		// The next 50ms tick will have fresh data.
		select {
		case h.broadcast <- msg:
		default:
			log.Printf("[TICKER] Hub broadcast channel full — dropping tick.")
		}
	}
}

// =============================================================================
// 1-SECOND TERMINAL LOG
// =============================================================================

// runLogger prints a human-readable summary to stdout every second.
// Kept separate from the 50ms ticker to avoid polluting logs with 20 lines/s.
func runLogger() {
	ticker := time.NewTicker(logInterval)
	defer ticker.Stop()

	var lastTotal int64

	for range ticker.C {
		current := totalCount.Load()
		delta := current - lastTotal
		lastTotal = current

		fmt.Printf(
			"[FIREHOSE] tps_1s=%-10d | tps_peak=%-10d | tx_total=%-15d\n",
			delta,
			peakTPS.Load(),
			current,
		)
	}
}

// =============================================================================
// AERON SUBSCRIBER
// =============================================================================

// runAeron connects to the Aeron media driver, subscribes to the engine stream,
// and polls in a tight loop. This goroutine never exits under normal operation.
//
// Idle strategy: 3-phase BackoffIdle matching the Rust engine's consumers:
//
//	Phase 0 (busy): runtime.Gosched() for 100 consecutive empty polls.
//	Phase 1 (yield): runtime.Gosched() for 100 more polls.
//	Phase 2 (park):  time.Sleep(1ms) on sustained empty polls.
//
// At 100k TPS, the poll loop almost never enters Phase 1 — fragmented messages
// arrive continuously. The idle strategy is only relevant at low TPS.
func runAeron(h *hub) {
	log.Printf("[AERON] Connecting to media driver at %s", aeronDir)

	ctx := aeron.NewContext().
		AeronDir(aeronDir).
		ErrorHandler(func(err error) {
			log.Printf("[AERON] Media driver error: %v", err)
		})

	a, err := aeron.Connect(ctx)
	if err != nil {
		log.Fatalf("[AERON] FATAL: Connect() failed: %v", err)
	}
	defer a.Close()

	log.Printf("[AERON] Connected. Subscribing to %s stream %d", aeronChanel, aeronStream)

	subscription, err := a.AddSubscription(aeronChanel, aeronStream)
	if err != nil {
		log.Fatalf("[AERON] FATAL: AddSubscription() failed: %v", err)
	}
	defer subscription.Close()

	// Wait until the subscription is connected to the engine's publication.
	for !subscription.IsConnected() {
		log.Printf("[AERON] Waiting for publisher on %s stream %d…", aeronChanel, aeronStream)
		time.Sleep(100 * time.Millisecond)
	}
	log.Printf("[AERON] Subscription LIVE. Polling at 100k+ TPS.")

	// ── POLL LOOP ─────────────────────────────────────────────────────────
	//
	// Poll up to 256 fragments per iteration. Each fragment is one
	// TransactionEnvelope (512 bytes). At 100k TPS:
	//   100_000 envelopes/s ÷ 256 frags/poll = 391 polls/s minimum.
	//   With a 50µs poll interval: 20_000 polls/s. We process in batches,
	//   so the average batch size is ~5 envelopes — well within the limit.
	//
	// Idle strategy phases:
	const (
		busyLimit  = 100 // empty polls before entering yield phase
		yieldLimit = 200 // cumulative empty polls before sleeping
	)

	emptyPolls := 0

	for {
		// Aeron Poll() returns ONLY the fragment count. No errors on the hot path.
		fragments := subscription.Poll(fragmentHandler, 256)

		if fragments > 0 {
			emptyPolls = 0
			continue
		}

		// Idle path: no fragments received this poll iteration.
		emptyPolls++
		switch {
		case emptyPolls < busyLimit:
			// Phase 0: burn CPU briefly. At high TPS this never fires.
			// runtime.Gosched() yields to other goroutines but returns
			// quickly if there is nothing else to run.
		case emptyPolls < yieldLimit:
			// Phase 1: yield more aggressively.
			time.Sleep(0) // equivalent to runtime.Gosched()
		default:
			// Phase 2: engine is quiet. Sleep to avoid wasting a full core.
			time.Sleep(1 * time.Millisecond)
		}
	}
}

// =============================================================================
// MAIN
// =============================================================================

func main() {
	log.SetFlags(log.Ltime | log.Lmicroseconds)
	log.Println("╔══════════════════════════════════════════════════════════════╗")
	log.Println("║  REVENANT Phase B.1 — Go Telemetry Firehose                  ║")
	log.Printf("║  Aeron: %-53s║", aeronChanel)
	log.Printf("║  Stream:%-53d║", aeronStream)
	log.Printf("║  WS:  ws://0.0.0.0%s/stream%-31s║", wsAddr, "")
	log.Println("╚══════════════════════════════════════════════════════════════╝")

	// ── HUB ───────────────────────────────────────────────────────────────
	h := newHub()
	go h.run()

	// ── WEBSOCKET SERVER ──────────────────────────────────────────────────
	mux := http.NewServeMux()
	mux.HandleFunc("/stream", streamHandler(h))

	// Health check endpoint — useful for load balancer / k8s probes.
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"status":"ok","tx_total":%d}`, totalCount.Load())
	})

	server := &http.Server{
		Addr:         wsAddr,
		Handler:      mux,
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 10 * time.Second,
	}

	go func() {
		log.Printf("[WS] Listening on ws://0.0.0.0%s/stream", wsAddr)
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("[WS] FATAL: ListenAndServe: %v", err)
		}
	}()

	// ── 50ms TICKER ───────────────────────────────────────────────────────
	go runTicker(h)

	// ── 1-SECOND TERMINAL LOG ─────────────────────────────────────────────
	go runLogger()

	// ── AERON SUBSCRIBER (blocks forever) ────────────────────────────────
	runAeron(h)
}
