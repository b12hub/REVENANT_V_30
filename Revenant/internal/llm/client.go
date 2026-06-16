package llm

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	//"io"
	"net/http"
	"time"

	"revenant-gateway/internal/domain"
)

// Client handles local inference via Ollama
type Client struct {
	endpoint   string
	httpClient *http.Client
}

func NewClient(endpoint string) *Client {
	return &Client{
		endpoint: endpoint,
		httpClient: &http.Client{
			Timeout: 60 * time.Second, // Strict 6-second SLA timeout
		},
	}
}

// AnalyzeIntent sends the user's text to the Local LLM and expects a deterministic JSON response
func (c *Client) AnalyzeIntent(ctx context.Context, intent *domain.IntentContext) error {
	// The System Prompt (Identity & Mandate)
	systemPrompt := `You are REVENANT AI CORE, a Tier-0 Sovereign Banking Agent. 
Your job is to analyze user requests and output STRICT JSON.
Never include markdown formatting. Return ONLY JSON.

Schema:
{
  "action": "TRANSFER" | "FREEZE_CARD" | "BALANCE_INQUIRY" | "UNKNOWN",
  "confidence": 0.0 to 1.0,
  "reasoning": "Brief technical explanation."
}`

	userPrompt := fmt.Sprintf("Analyze this request:\nSubject: %s\nAmount: %.2f %s", intent.Subject, intent.TransactionAmt, intent.Currency)

	// Ollama /api/generate payload
	reqBody, _ := json.Marshal(map[string]interface{}{
		"model":   "llama3.2",
		"system":  systemPrompt,
		"prompt":  userPrompt,
		"format":  "json",
		"stream":  false,
		"options": map[string]interface{}{"temperature": 0.0}, // Absolute zero for deterministic output
	})

	req, err := http.NewRequestWithContext(ctx, "POST", c.endpoint+"/api/generate", bytes.NewBuffer(reqBody))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")

	start := time.Now()
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("llm timeout or unreachable: %w", err)
	}
	defer resp.Body.Close()

	var result struct {
		Response string `json:"response"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return err
	}

	// Parse the LLM's JSON string into our domain Advisory Result
	var advisory struct {
		Action     string  `json:"action"`
		Confidence float64 `json:"confidence"`
		Reasoning  string  `json:"reasoning"`
	}
	if err := json.Unmarshal([]byte(result.Response), &advisory); err != nil {
		return fmt.Errorf("llm hallucinated invalid json: %w", err)
	}

	// Mutate the state context with the AI's decision
	intent.Advisory = domain.AdvisoryResult{
		Action:     advisory.Action,
		Confidence: advisory.Confidence,
		Reasoning:  advisory.Reasoning,
		LatencyMs:  time.Since(start).Milliseconds(),
		Source:     "LOCAL_LLAMA3",
	}

	return nil
}
