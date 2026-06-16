package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"revenant-gateway/internal/api"
	"revenant-gateway/internal/llm"
	"time"

	"revenant-gateway/internal/aeronpub"
	"revenant-gateway/internal/domain"
	"revenant-gateway/internal/policy"
	"revenant-gateway/internal/queue"
)

func main() {

	log.Println("╔══════════════════════════════════════════════════════════════╗")
	log.Println("║  REVENANT ORCHESTRATOR — The Agentic Banking Brain           ║")
	log.Println("╚══════════════════════════════════════════════════════════════╝")

	// 0. Configure Sovereign Business Rules
	policy.Configure(12850.0) // Current UZS to USD rate

	// 1. Initialize the Local LLM Client
	aiClient := llm.NewClient("http://127.0.0.1:11434")

	// 2. Initialize the Aeron IPC Bridge
	aeronPublisher, err := aeronpub.NewPublisher("/dev/shm/aeron-go")
	if err != nil {
		log.Fatalf("FATAL: Cannot connect to Aeron Media Driver: %v", err)
	}
	defer aeronPublisher.Close()

	// PRINT THE PUBLIC KEY FOR RUST TO USE
	fmt.Printf("\n[ATTENTION] RUST ED25519 PUBLIC KEY: %v\n\n", aeronPublisher.PublicKey)

	// 2. Initialize the Async Worker Pool (Buffer of 4096 requests)
	pool := queue.NewWorkerPool(4096, aiClient, aeronPublisher)
	pool.Start(8) // 8 concurrent AI orchestration threads

	// 2. Setup the HTTP Ingress
	http.HandleFunc("/v1/intent", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}

		// Decode the raw JSON from the mobile app
		var payload struct {
			TraceID string  `json:"trace_id"`
			Subject string  `json:"subject"`
			Amount  float64 `json:"amount"`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			http.Error(w, "Bad Request", http.StatusBadRequest)
			return
		}

		// Build the Canonical Context
		ctx := &domain.IntentContext{
			TraceID:         payload.TraceID,
			WebhookReceived: time.Now(),
			UnixStart:       time.Now().UnixMilli(),
			Subject:         payload.Subject,
			TransactionAmt:  payload.Amount,
			Currency:        "USD",
		}

		// Run the Titanium Sanitizer (BLOCK 0) before enqueuing
		if err := api.SanitizeAndCheck(ctx); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		// Drop into the async worker queue
		if success := pool.Enqueue(ctx); !success {
			http.Error(w, "Too Many Requests - Try Again Later", http.StatusTooManyRequests)
			return
		}

		// Instantly return 200 OK (Async Handoff)
		w.WriteHeader(http.StatusAccepted)
		fmt.Fprintf(w, `{"status": "queued", "trace_id": "%s"}`, ctx.TraceID)
	})

	// 4. Hardened HTTP Server (Slowloris Protection)
	server := &http.Server{
		Addr:         ":8083",
		ReadTimeout:  5 * time.Second,  // Max time to read request headers/body
		WriteTimeout: 10 * time.Second, // Max time to write response
		IdleTimeout:  15 * time.Second, // Max time to keep keep-alive connections open
	}

	log.Println("[API] Ingress Server listening on :8083 (Hardened)")
	log.Fatal(server.ListenAndServe())
}
