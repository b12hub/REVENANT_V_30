package domain

import "time"

// IntentContext is the canonical state carrier for the revenant-orchestrator.
type IntentContext struct {
	// Golden Thread — set once at ingress, never overwritten
	TraceID         string    `json:"trace_id"`
	WebhookReceived time.Time `json:"webhook_received_at"`
	UnixStart       int64     `json:"unix_start_ms"`

	// Raw inbound payload
	Subject        string  `json:"subject"`
	Body           string  `json:"body"`
	CustomerEmail  string  `json:"customer_email"`
	TransactionAmt float64 `json:"transaction_amount"`
	Currency       string  `json:"currency"`
	AmountAtomic   int64   `json:"amount_atomic"`
	MessageType    string  `json:"message_type"`

	// ─── AI ADVISORY ──────────────────────────────────────────────────
	Advisory AdvisoryResult `json:"advisory"`

	// Terminal State
	FinalStatus   string       `json:"final_status"`
	Consumed      bool         `json:"consumed"`
	WorkflowError *WorkflowErr `json:"workflow_error,omitempty"`

	TextFeatures FeatureSet     `json:"text_features"`
	LangAnalysis LanguageResult `json:"lang_analysis"`
	RuleEngine   IntentResult   `json:"rule_engine"`
	Severity     SeverityResult `json:"severity"`
	PolicyResult PolicyCheck    `json:"policy_result"`

	// ─── COMPLIANCE & POLICY ──────────────────────────────────────────
	SARRequired    bool            `json:"sar_required"`
	InvariantCheck InvariantResult `json:"invariant_check"`

	SARPayload *SARData     `json:"sar_payload,omitempty"`
	Contract   ContractData `json:"contract"`
}

// AdvisoryResult holds the output from the Local LLM
type AdvisoryResult struct {
	Reasoning  string  `json:"reasoning"`
	Action     string  `json:"action"`
	Confidence float64 `json:"confidence"`
	Source     string  `json:"source"`     // e.g., LOCAL_LLAMA3
	LatencyMs  int64   `json:"latency_ms"` // How long the LLM took to think
}

type WorkflowErr struct {
	Type   string    `json:"type"`
	Errors []string  `json:"errors"`
	Stage  string    `json:"stage"`
	At     time.Time `json:"timestamp"`
}

// ─── CLASSIFICATION TYPES ─────────────────────────────────────────────────────

type FeatureSet struct {
	HasCardNumber     bool `json:"has_card_number"`
	HasPhoneNumber    bool `json:"has_phone_number"`
	HasAccountNumber  bool `json:"has_account_number"`
	HasCryptoTerms    bool `json:"has_crypto_terms"`
	HasUrgentKeywords bool `json:"has_urgent_keywords"`
	HasSecurityTerms  bool `json:"has_security_terms"`
	HasCritical       bool `json:"has_critical"`
	HasErrorCode      bool `json:"has_error_code"`
}

type LanguageResult struct {
	Detected   string  `json:"detected"`
	Confidence float64 `json:"confidence"`
	Status     string  `json:"status"`
}

type IntentResult struct {
	Intent     string    `json:"intent"`
	Confidence float64   `json:"confidence"`
	Severity   string    `json:"severity"`
	Source     string    `json:"source"`
	DetectedAt time.Time `json:"detected_at"`
}

type SeverityResult struct {
	Level      string             `json:"level"`
	Confidence float64            `json:"confidence"`
	Scores     map[string]float64 `json:"scores"`
}

type PolicyCheck struct {
	FirewallStatus string  `json:"firewall_status"`
	Reason         string  `json:"reason,omitempty"`        // <--- NEW
	ForensicFlag   bool    `json:"forensic_flag,omitempty"` // <--- NEW
	AmountUSD      float64 `json:"amount_usd"`
	AmountUZS      float64 `json:"amount_uzs"`
	HardCeiling    float64 `json:"hard_ceiling"`
}

type InvariantResult struct {
	Status     string    `json:"status"`
	Violations []string  `json:"violations"`
	CheckedAt  time.Time `json:"checked_at"`
}

// ─── COMPLIANCE & CONTRACT TYPES ──────────────────────────────────────────────

type SARData struct {
	XML             string  `json:"xml"`
	ReportingReason string  `json:"reporting_reason"`
	AmountUSD       float64 `json:"amount_usd"`
	Threshold       float64 `json:"threshold"`
	Priority        string  `json:"priority"`
	QueueTarget     string  `json:"queue_target"`
}

type ContractIntent struct {
	TargetTool string `json:"target_tool"`
}

type ContractData struct {
	State  string         `json:"state"`
	Intent ContractIntent `json:"intent"`
}
