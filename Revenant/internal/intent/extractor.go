// internal/intent/extractor.go
// Phase F Constrained Intent Extractor — Grammar-Constrained Structured Tool Invocation (CSTI)
//
// CSTI MECHANISM:
//
//   This file implements the AI Control Plane's "cage" around the local Llama 3.2 model.
//   The constraint is applied at two independent levels:
//
//   LEVEL 1 — GRAMMAR CONSTRAINT (Ollama structured output):
//     The `format` field in the Ollama /api/chat request carries a JSON Schema object.
//     Ollama enforces this schema at the logit-sampling level: on every token generation
//     step, it masks the probability distribution to zero for any token that would
//     produce output violating the schema. It is PHYSICALLY IMPOSSIBLE for the model
//     to output a syntactically invalid response (e.g., an action_type not in the enum).
//
//     This is Grammar-Constrained Sampling, equivalent to Backus-Naur Form (BNF)
//     grammars in llama.cpp. The schema IS the grammar. The LLM cannot deviate.
//
//   LEVEL 2 — SEMANTIC VALIDATION (schema.go):
//     Even with a structurally valid JSON, the model could hallucinate a semantically
//     invalid response (e.g., TRANSFER with amount=0, recipient="12345678901234567").
//     The ValidateResponse() function in schema.go catches these cases independently.
//
//   COMBINED EFFECT:
//     A transaction can only reach the ICDE pipeline if:
//     (a) The JSON schema constraint passed (Ollama grammar sampling).
//     (b) The semantic validator passed (schema.go ValidateResponse).
//     (c) The firewall passed (semantic.go Sanitize).
//     All three are independently enforced with no shared code path.
//
// OLLAMA API:
//
//   Endpoint: POST /api/chat (Ollama v0.5+ structured output API)
//   Format:   The `format` field accepts a JSON Schema object (not just "json").
//             This enables constrained sampling, not just "try to output JSON".
//
//   Reference: https://ollama.com/blog/structured-outputs
//
// SYSTEM PROMPT DESIGN:
//
//   The system prompt serves a different purpose from the format schema:
//   - Schema: structural/syntactic constraint (what the JSON must look like).
//   - System prompt: semantic guidance (how to assign action types, what each means).
//
//   The system prompt is written to be minimal and deterministic. Temperature=0
//   ensures greedy decoding — the model always picks the highest-probability token.
//   Combined with the grammar constraint, this makes extraction fully deterministic
//   for identical inputs.
//
// CIRCUIT BREAKER:
//
//   The local Ollama instance can fail or become unresponsive during model loading
//   or VRAM pressure. A circuit breaker with a 30s recovery window prevents the
//   goroutine pool from flooding Ollama with requests it cannot serve.
//   After 3 consecutive failures, the circuit opens and returns ErrCircuitOpen
//   until the recovery window expires.

package intent

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"sync/atomic"
	"time"
)

// ─── OLLAMA JSON SCHEMA (CSTI FORMAT PARAMETER) ───────────────────────────────
//
// This JSON Schema is sent in the `format` field of every Ollama request.
// It is the formal grammar constraint enforced at the logit-sampling level.
//
// SCHEMA INVARIANTS:
//   - `action_type` is a string enum: only the four defined values can be sampled.
//   - `amount` is a number: cannot be a string like "two million".
//   - `currency` is a string enum: only the four defined values can be sampled.
//   - `recipient` and `description` are bounded-length strings.
//   - All five fields are required: the model cannot omit any field.
//
// This schema MUST stay in sync with the Action struct in schema.go.
// The json: field tags on Action are the ABI — change either, change both.
//
// Defined as a package-level var marshaled once at init time to avoid
// per-request JSON marshaling overhead.
var ollamaFormatSchema json.RawMessage

func init() {
	schema := map[string]any{
		"type":     "object",
		"required": []string{"actions"},
		"properties": map[string]any{
			"actions": map[string]any{
				"type":        "array",
				"description": "List of extracted banking intents. One entry per distinct action.",
				"items": map[string]any{
					"type":     "object",
					"required": []string{"action_type", "amount", "currency", "recipient", "description"},
					"properties": map[string]any{
						"action_type": map[string]any{
							"type":        "string",
							"enum":        []string{"TRANSFER", "PAY_BILL", "CARD_BLOCK", "UNKNOWN_INTENT"},
							"description": "The type of banking operation to perform.",
						},
						"amount": map[string]any{
							"type":        "number",
							"minimum":     0,
							"maximum":     2_000_000_000,
							"description": "Numeric amount in the denomination specified by currency. Use 0 if amount is unknown or not applicable.",
						},
						"currency": map[string]any{
							"type":        "string",
							"enum":        []string{"UZS", "USD", "EUR", "RUB"},
							"description": "Currency of the amount. Default to UZS if not specified.",
						},
						"recipient": map[string]any{
							"type":        "string",
							"maxLength":   100,
							"description": "Semantic name of the recipient (person, business, or biller). NEVER an account number. Empty string for CARD_BLOCK and UNKNOWN_INTENT.",
						},
						"description": map[string]any{
							"type":        "string",
							"maxLength":   300,
							"description": "Brief description for the audit log. Do not repeat the raw user input verbatim.",
						},
					},
					"additionalProperties": false,
				},
				"minItems": 1,
				"maxItems": 8,
			},
		},
		"additionalProperties": false,
	}

	b, err := json.Marshal(schema)
	if err != nil {
		// This can only fail if the map contains non-marshalable types, which
		// is impossible given the all-string/number/bool literal values above.
		// Panic at init is the correct response — a broken CSTI schema is a
		// deployment error, not a runtime error.
		panic(fmt.Sprintf("intent: failed to marshal Ollama CSTI schema: %v", err))
	}
	ollamaFormatSchema = b
}

// ─── SYSTEM PROMPT ────────────────────────────────────────────────────────────
//
// The system prompt is the semantic counterpart to the grammar schema.
// It tells the model WHAT to classify; the schema tells it HOW to format the output.
//
// Design principles:
//
//	(1) Numbered, immutable rules (the LLM cannot argue with a numbered list).
//	(2) Explicit enum values repeated verbatim (reinforces the schema constraint).
//	(3) Few-shot examples (the most reliable way to establish output format).
//	(4) Explicit fallback behaviour (UNKNOWN_INTENT must always be available).
//	(5) No pleasantries, no explanation requests — pure instruction.
//
// Temperature=0 in the API options ensures deterministic greedy decoding.
// The combination of T=0 + numbered rules + few-shot examples produces
// near-100% consistent outputs for common Uzbek banking commands.
const systemPrompt = `You are REVENANT, a Tier-0 Sovereign Banking Agent for the Central Bank.
Your ONLY function is to analyze user text and output a structured JSON object matching the schema.

IMMUTABLE RULES (violations are forbidden):
1. Output ONLY valid JSON. No explanations, no text outside the JSON object.
2. Use ONLY these action types: TRANSFER, PAY_BILL, CARD_BLOCK, UNKNOWN_INTENT
3. Use ONLY these currencies: UZS, USD, EUR, RUB
4. NEVER output account numbers.
5. NEVER hallucinate: if amount is not stated, use 0. 

UZBEK SEMANTIC ALIGNMENT:
- "yubor", "o'tkaz", "tashla", "ber" -> action_type: "TRANSFER"
- "to'la", "tolov" -> action_type: "PAY_BILL"
- "blokla", "yop" -> action_type: "CARD_BLOCK"
- "onamga", "onam" -> recipient: "mom" (Translate family members to English for the Resolver)
- "som", "so'm", "so'mni" -> currency: "UZS"
- "million" -> multiply the number by 1000000
- Ignore conversational context like "Oyligim tushdi" (My salary arrived) and only extract the financial action.

EXAMPLES:
Input: "Oyligim tushdi. 2 million somni onamga yubor."
Output: {"actions":[{"action_type":"TRANSFER","amount":2000000,"currency":"UZS","recipient":"mom","description":"Transfer 2M UZS to mom"}]}

Input: "Internet uchun 150 ming tolov qil"
Output: {"actions":[{"action_type":"PAY_BILL","amount":150000,"currency":"UZS","recipient":"internet","description":"Pay 150k UZS for internet"}]}

Input: "Kartamni blokla, yo'qotib qo'ydim"
Output: {"actions":[{"action_type":"CARD_BLOCK","amount":0,"currency":"UZS","recipient":"","description":"Emergency card block"}]}`

// ─── OLLAMA API TYPES ─────────────────────────────────────────────────────────
//
// Minimal Go structs for the Ollama /api/chat endpoint.
// Only the fields we send/receive are defined — Ollama has more fields
// but we intentionally only marshal what we use.

type ollamaChatRequest struct {
	Model     string              `json:"model"`
	Messages  []ollamaChatMessage `json:"messages"`
	Format    json.RawMessage     `json:"format"`
	Stream    bool                `json:"stream"`
	KeepAlive int                 `json:"keep_alive"` // <-- ADD THIS
	Options   ollamaOptions       `json:"options"`
}

type ollamaChatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type ollamaOptions struct {
	Temperature float64 `json:"temperature"`
	TopP        float64 `json:"top_p"`
	Seed        int     `json:"seed"`
	NumPredict  int     `json:"num_predict"` // max tokens to generate
}

type ollamaChatResponse struct {
	Message ollamaChatMessage `json:"message"`
	Error   string            `json:"error,omitempty"`
}

// ─── CIRCUIT BREAKER STATE ────────────────────────────────────────────────────

// circuitState represents the circuit breaker's current state.
type circuitState int32

const (
	circuitClosed circuitState = 0 // normal operation
	circuitOpen   circuitState = 1 // failing, requests blocked
)

// ─── EXTRACTOR CONFIG ─────────────────────────────────────────────────────────

// Config holds all runtime parameters for the Extractor.
type Config struct {
	// OllamaBaseURL is the base URL of the local Ollama instance.
	// Default: "http://localhost:11434"
	OllamaBaseURL string

	// Model is the Ollama model tag to use.
	// Default: "llama3.2" — must be pulled and available in the Ollama instance.
	Model string

	// RequestTimeout is the maximum duration for a single Ollama inference request.
	// Default: 6 seconds. Matches the existing LLM timeout in the architecture.
	// A local Llama 3.2 on a GPU should respond in < 1s for typical banking commands.
	// 6s provides headroom for cold-start model loading.
	RequestTimeout time.Duration

	// MaxRetries is the number of additional attempts after the first failure.
	// Default: 2 (3 total attempts). Not applied on timeout — user is waiting.
	MaxRetries int

	// RetryDelay is the initial backoff delay between retries.
	// Doubles on each retry: 100ms → 200ms.
	RetryDelay time.Duration

	// CircuitBreakerThreshold: consecutive failures before opening the circuit.
	// Default: 3.
	CircuitBreakerThreshold int32

	// CircuitBreakerRecovery: how long to keep the circuit open before trying again.
	// Default: 30 seconds.
	CircuitBreakerRecovery time.Duration
}

// DefaultConfig returns a Config with production-safe defaults.
func DefaultConfig() Config {
	return Config{
		OllamaBaseURL:           "http://localhost:11434",
		Model:                   "qwen2.5:3b",
		RequestTimeout:          100 * time.Second, // <-- INCREASED FROM 6 TO 100
		MaxRetries:              2,
		RetryDelay:              100 * time.Millisecond,
		CircuitBreakerThreshold: 3,
		CircuitBreakerRecovery:  30 * time.Second,
	}
}

// ─── EXTRACTOR ────────────────────────────────────────────────────────────────

// Extractor is the Constrained Intent Extractor. It manages the HTTP client,
// circuit breaker, and retry logic for calls to the local Ollama instance.
// Safe for concurrent use by multiple goroutines.
type Extractor struct {
	cfg     Config
	client  *http.Client
	chatURL string

	// Circuit breaker state — accessed via atomic operations only.
	consecutiveFails atomic.Int32
	circuitState     atomic.Int32 // stores circuitState (0=closed, 1=open)
	circuitOpenedAt  atomic.Int64 // unix nanoseconds
}

// New constructs an Extractor with the given Config.
func New(cfg Config) *Extractor {
	if cfg.OllamaBaseURL == "" {
		cfg.OllamaBaseURL = DefaultConfig().OllamaBaseURL
	}
	if cfg.Model == "" {
		cfg.Model = DefaultConfig().Model
	}
	if cfg.RequestTimeout == 0 {
		cfg.RequestTimeout = DefaultConfig().RequestTimeout
	}
	if cfg.CircuitBreakerThreshold == 0 {
		cfg.CircuitBreakerThreshold = DefaultConfig().CircuitBreakerThreshold
	}
	if cfg.CircuitBreakerRecovery == 0 {
		cfg.CircuitBreakerRecovery = DefaultConfig().CircuitBreakerRecovery
	}
	if cfg.RetryDelay == 0 {
		cfg.RetryDelay = DefaultConfig().RetryDelay
	}
	if cfg.MaxRetries < 0 {
		cfg.MaxRetries = 0
	}

	return &Extractor{
		cfg:     cfg,
		chatURL: cfg.OllamaBaseURL + "/api/chat",
		client: &http.Client{
			// The per-request context timeout (cfg.RequestTimeout) controls actual
			// inference time. This transport-level timeout is a safety net for
			// network-layer hangs (e.g., connection refused, TCP reset).
			Timeout: cfg.RequestTimeout + 2*time.Second,
		},
	}
}

// ─── SENTINEL ERRORS ─────────────────────────────────────────────────────────

// ErrCircuitOpen is returned when the circuit breaker is open.
// The caller should return an appropriate user-facing error (e.g., "system busy")
// without retrying until the circuit closes.
var ErrCircuitOpen = fmt.Errorf("intent extractor circuit open: Ollama instance unhealthy, retry after recovery window")

// ExtractionError carries a structured extraction failure for the audit log.
type ExtractionError struct {
	Stage   string // "circuit_check" | "http_request" | "json_decode" | "schema_validation"
	Detail  string
	Wrapped error
}

func (e *ExtractionError) Error() string {
	return fmt.Sprintf("intent extraction failed at stage=%s: %s", e.Stage, e.Detail)
}
func (e *ExtractionError) Unwrap() error { return e.Wrapped }

// ─── EXTRACT ─────────────────────────────────────────────────────────────────

// Extract runs the full CSTI pipeline for a user command.
//
// Precondition: userText has already been processed by the Semantic Firewall
// (semantic.go Sanitize). Calling Extract on unsanitized input violates the
// Phase F AI Control Plane ordering invariant.
//
// The function:
//  1. Checks the circuit breaker.
//  2. Calls Ollama /api/chat with the CSTI format schema (grammar constraint).
//  3. Decodes the structured JSON response.
//  4. Validates the response against schema.go rules.
//  5. Returns the validated []Action slice or a typed error.
//
// On success: returns a *IntentResponse where every Action is validated.
// On failure: returns nil + a typed error. The caller must treat this as
//
//	pipeline halt — do not attempt to route a nil/partial response.
func (e *Extractor) Extract(ctx context.Context, userText string) (*IntentResponse, error) {
	// ── CIRCUIT BREAKER CHECK ─────────────────────────────────────────────
	if err := e.checkCircuit(); err != nil {
		return nil, err
	}

	// ── BUILD REQUEST ─────────────────────────────────────────────────────
	reqBody := ollamaChatRequest{
		Model: e.cfg.Model,
		Messages: []ollamaChatMessage{
			{Role: "system", Content: systemPrompt},
			{Role: "user", Content: userText},
		},
		Format:    ollamaFormatSchema,
		Stream:    false,
		KeepAlive: -1, // <-- LOCK IN GPU VRAM FOREVER
		Options: ollamaOptions{
			Temperature: 0.0, // Fully deterministic — required for financial operations.
			TopP:        1.0, // Disabled (Temperature=0 makes top_p irrelevant).
			Seed:        42,  // Deterministic seed for reproducible audit replay.
			NumPredict:  512, // Max 512 tokens. A 8-action response is ~300 tokens.
		},
	}

	// ── CALL WITH RETRY ───────────────────────────────────────────────────
	var (
		response *IntentResponse
		lastErr  error
	)
	delay := e.cfg.RetryDelay

	for attempt := 0; attempt <= e.cfg.MaxRetries; attempt++ {
		if attempt > 0 {
			select {
			case <-ctx.Done():
				return nil, &ExtractionError{
					Stage:   "retry_wait",
					Detail:  "context cancelled during retry backoff",
					Wrapped: ctx.Err(),
				}
			case <-time.After(delay):
				delay *= 2
			}
		}

		response, lastErr = e.doRequest(ctx, reqBody)
		if lastErr == nil {
			// Success — record and return.
			e.recordSuccess()
			return response, nil
		}

		// Do not retry on context deadline/cancellation — user is waiting.
		if ctx.Err() != nil {
			e.recordFailure()
			return nil, &ExtractionError{
				Stage:   "http_request",
				Detail:  "request timed out or context cancelled",
				Wrapped: ctx.Err(),
			}
		}

		// Retryable failure — continue the loop.
	}

	// All attempts exhausted.
	e.recordFailure()
	return nil, lastErr
}

// ─── SINGLE HTTP REQUEST ──────────────────────────────────────────────────────

// doRequest performs a single Ollama /api/chat request and returns the parsed,
// validated IntentResponse.
func (e *Extractor) doRequest(ctx context.Context, req ollamaChatRequest) (*IntentResponse, error) {
	// ── ENCODE REQUEST ────────────────────────────────────────────────────
	body, err := json.Marshal(req)
	if err != nil {
		return nil, &ExtractionError{
			Stage:   "json_encode",
			Detail:  "failed to marshal Ollama request",
			Wrapped: err,
		}
	}

	// ── CREATE HTTP REQUEST WITH TIMEOUT ──────────────────────────────────
	reqCtx, cancel := context.WithTimeout(ctx, e.cfg.RequestTimeout)
	defer cancel()

	httpReq, err := http.NewRequestWithContext(reqCtx, http.MethodPost, e.chatURL, bytes.NewReader(body))
	if err != nil {
		return nil, &ExtractionError{
			Stage:   "http_build",
			Detail:  fmt.Sprintf("failed to build HTTP request to %s", e.chatURL),
			Wrapped: err,
		}
	}
	httpReq.Header.Set("Content-Type", "application/json")

	// ── EXECUTE ───────────────────────────────────────────────────────────
	resp, err := e.client.Do(httpReq)
	if err != nil {
		return nil, &ExtractionError{
			Stage:   "http_request",
			Detail:  fmt.Sprintf("HTTP request to Ollama failed: %v", err),
			Wrapped: err,
		}
	}
	defer resp.Body.Close()

	// ── READ RESPONSE ─────────────────────────────────────────────────────
	// Limit read to 64KB — a CSTI response cannot exceed ~1KB, so 64KB provides
	// generous headroom while preventing memory exhaustion from a misbehaving
	// Ollama instance.
	limitedBody := io.LimitReader(resp.Body, 64*1024)
	rawBody, err := io.ReadAll(limitedBody)
	if err != nil {
		return nil, &ExtractionError{
			Stage:   "http_read",
			Detail:  "failed to read Ollama response body",
			Wrapped: err,
		}
	}

	if resp.StatusCode != http.StatusOK {
		return nil, &ExtractionError{
			Stage:  "http_status",
			Detail: fmt.Sprintf("Ollama returned HTTP %d — model may not be loaded", resp.StatusCode),
		}
	}

	// ── DECODE OLLAMA ENVELOPE ────────────────────────────────────────────
	var ollamaResp ollamaChatResponse
	if err := json.Unmarshal(rawBody, &ollamaResp); err != nil {
		return nil, &ExtractionError{
			Stage:   "json_decode_envelope",
			Detail:  "failed to decode Ollama API response envelope",
			Wrapped: err,
		}
	}
	if ollamaResp.Error != "" {
		return nil, &ExtractionError{
			Stage:  "ollama_error",
			Detail: fmt.Sprintf("Ollama returned error: %s", ollamaResp.Error),
		}
	}

	// The LLM's output is in ollamaResp.Message.Content as a JSON string.
	// The CSTI format constraint means this string MUST be valid JSON matching
	// our schema — but we unmarshal defensively and validate regardless.
	// ── DECODE INTENT RESPONSE (inner JSON from LLM content) ──────────────
	rawContent := strings.TrimSpace(ollamaResp.Message.Content)
	log.Printf("[AI RAW OUTPUT] %s", rawContent) // Print exactly what Llama 3.2 said

	// Defensively strip Markdown code block formatting
	rawContent = strings.TrimPrefix(rawContent, "```json")
	rawContent = strings.TrimPrefix(rawContent, "```")
	rawContent = strings.TrimSuffix(rawContent, "```")
	rawContent = strings.TrimSpace(rawContent)

	var intentResp IntentResponse
	if err := json.Unmarshal([]byte(rawContent), &intentResp); err != nil {
		return nil, &ExtractionError{
			Stage:   "json_decode_intent",
			Detail:  fmt.Sprintf("LLM output is not valid JSON: %v", err),
			Wrapped: err,
		}
	}
	// ── SEMANTIC VALIDATION ───────────────────────────────────────────────
	//
	// The grammar constraint (Level 1) ensured structural validity.
	// ValidateResponse (Level 2) enforces semantic correctness.
	// Both must pass independently.
	validationResult := ValidateResponse(&intentResp)
	if !validationResult.Valid {
		return nil, &ExtractionError{
			Stage:  "schema_validation",
			Detail: fmt.Sprintf("CSTI output failed semantic validation: %s", FormatValidationErrors(validationResult)),
		}
	}

	return &intentResp, nil
}

// ─── CIRCUIT BREAKER MECHANICS ────────────────────────────────────────────────

// checkCircuit returns ErrCircuitOpen if the circuit is open and the recovery
// window has not elapsed. If the recovery window HAS elapsed, it transitions
// the circuit to half-open (allows one trial request through).
func (e *Extractor) checkCircuit() error {
	if circuitState(e.circuitState.Load()) == circuitClosed {
		return nil
	}
	// Circuit is open — check recovery window.
	openedAt := time.Unix(0, e.circuitOpenedAt.Load())
	if time.Since(openedAt) >= e.cfg.CircuitBreakerRecovery {
		// Recovery window elapsed — allow this request through as a probe.
		// If it succeeds, recordSuccess will close the circuit.
		// If it fails, recordFailure will re-open with a fresh timestamp.
		e.circuitState.Store(int32(circuitClosed))
		return nil
	}
	return ErrCircuitOpen
}

// recordSuccess resets the failure counter and closes the circuit.
func (e *Extractor) recordSuccess() {
	e.consecutiveFails.Store(0)
	e.circuitState.Store(int32(circuitClosed))
}

// recordFailure increments the failure counter and opens the circuit if the
// threshold is exceeded.
func (e *Extractor) recordFailure() {
	fails := e.consecutiveFails.Add(1)
	if fails >= e.cfg.CircuitBreakerThreshold {
		e.circuitOpenedAt.Store(time.Now().UnixNano())
		e.circuitState.Store(int32(circuitOpen))
	}
}
