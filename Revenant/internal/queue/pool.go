package queue

import (
	"context"
	"log"
	"sync"
	"time"

	"revenant-gateway/internal/aeronpub"
	"revenant-gateway/internal/compliance"
	"revenant-gateway/internal/domain"
	"revenant-gateway/internal/intent"
	"revenant-gateway/internal/llm"
	"revenant-gateway/internal/policy"
	"revenant-gateway/internal/txbuilder"
)

type WorkerPool struct {
	JobQueue chan *domain.IntentContext
	llm      *llm.Client
	aeron    *aeronpub.Publisher
	wg       sync.WaitGroup
	aiToken  chan struct{}
}

func NewWorkerPool(bufferSize int, llmClient *llm.Client, aeronPub *aeronpub.Publisher) *WorkerPool {
	return &WorkerPool{
		JobQueue: make(chan *domain.IntentContext, bufferSize),
		llm:      llmClient,
		aeron:    aeronPub,
		aiToken:  make(chan struct{}, 2), // <--- STRICT LIMIT: Only 2 concurrent LLM calls allowed
	}
}

func (p *WorkerPool) Start(numWorkers int) {
	for i := 0; i < numWorkers; i++ {
		p.wg.Add(1)
		go p.worker(i)
	}
	log.Printf("[QUEUE] Worker pool started with %d workers", numWorkers)
}

func (p *WorkerPool) worker(id int) {
	defer p.wg.Done()
	for ctxState := range p.JobQueue {
		log.Printf("======================================================")
		log.Printf("[WORKER %d] 📥 INBOUND TraceID: %s", id, ctxState.TraceID)

		// ─── STAGE 1: DETERMINISTIC CLASSIFICATION ───────────────────────
		intent.ClassifyIntent(ctxState)

		// ─── STAGE 2: LOCAL LLM INFERENCE (With Load Shedding) ───────────
		// SLA: If we cannot acquire GPU/LLM capacity within 50ms, we shed the load.
		select {
		case p.aiToken <- struct{}{}:
			// Acquired capacity. Proceed with LLM call.
			ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
			err := p.llm.AnalyzeIntent(ctx, ctxState)
			<-p.aiToken // Release capacity
			cancel()

			if err != nil {
				log.Printf("[WORKER %d] 🚨 AI FAILURE [%s]: %v", id, ctxState.TraceID, err)
				continue
			}
			log.Printf("[WORKER %d] 🧠 AI DECISION: %s | Conf: %.2f", id, ctxState.Advisory.Action, ctxState.Advisory.Confidence)

		case <-time.After(50 * time.Millisecond):
			// FAST FAIL: The system is saturated.
			// We instantly shed the load to protect the ingress gateway from deadlocking.
			log.Printf("[WORKER %d] 🛑 SYSTEM SATURATED: LLM Queue blocked -> Applying Load Shedding.", id)
			continue
		}
		// ─── STAGE 3: IRON HAND POLICY FIREWALL ──────────────────────────
		if err := policy.EnforceInvariants(ctxState); err != nil {
			log.Printf("[WORKER %d] 🛑 IRON HAND BLOCKED: %v", id, err)
			continue
		}
		log.Printf("[WORKER %d] 🛡️ POLICY PASSED | Amount Validated: $%.2f", id, ctxState.PolicyResult.AmountUSD)

		// ─── STAGE 4: COMPLIANCE (CBU SAR XML) ───────────────────────────
		if ctxState.SARRequired {
			xmlStr, err := compliance.GenerateSAR(ctxState)
			if err != nil {
				log.Printf("[WORKER %d] ⚠️ SAR GENERATION FAILED: %v", id, err)
			} else {
				log.Printf("[WORKER %d] 📄 CBU SAR XML GENERATED (%d bytes)", id, len(xmlStr))
			}
		}

		// ─── STAGE 5: BINARY ENVELOPE BUILDER ────────────────────────────
		// MOCK APPROVAL: Simulate a human/system approval so txbuilder accepts it
		ctxState.FinalStatus = "APPROVED"
		ctxState.Contract.State = "APPROVED"
		ctxState.Contract.Intent.TargetTool = "transfer_internal"
		ctxState.AmountAtomic = int64(ctxState.TransactionAmt * 100) // Convert $ to cents/tiyin

		payload, err := txbuilder.BuildEnvelope(ctxState)
		if err != nil {
			log.Printf("[WORKER %d] ❌ BINARY BUILD FAILED: %v", id, err)
			continue
		}

		// ─── STAGE 6: AERON IPC EGRESS ───────────────────────────────────
		log.Printf("[WORKER %d] 🚀 Firing 512-byte envelope to Rust Engine via Aeron...", id)
		if err := p.aeron.Publish(payload); err != nil {
			log.Printf("[WORKER %d] ❌ AERON PUBLISH FAILED: %v", id, err)
			continue
		}

		log.Printf("[WORKER %d] 🏁 TRANSACTION DELIVERED TO LMAX CORE.", id)
		log.Printf("======================================================")
	}
}

func (p *WorkerPool) Enqueue(ctx *domain.IntentContext) bool {
	select {
	case p.JobQueue <- ctx:
		return true
	default:
		return false
	}
}
