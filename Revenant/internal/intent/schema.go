package intent

import (
	"fmt"
	"strings"
)

// ─── ACTION TYPE ENUM ─────────────────────────────────────────────────────────

type ActionType uint8

const (
	ActionTransfer      ActionType = 1
	ActionPayBill       ActionType = 2
	ActionCardBlock     ActionType = 3
	ActionUnknownIntent ActionType = 99
)

var validActionTypes = map[ActionType]struct{}{
	ActionTransfer:      {},
	ActionPayBill:       {},
	ActionCardBlock:     {},
	ActionUnknownIntent: {},
}

func (t ActionType) IsValid() bool {
	_, ok := validActionTypes[t]
	return ok
}

func (t ActionType) RequiresRecipient() bool {
	return t == ActionTransfer || t == ActionPayBill
}

func (t ActionType) RequiresPositiveAmount() bool {
	return t == ActionTransfer
}

func (t ActionType) MustHaveZeroAmount() bool {
	return t == ActionCardBlock || t == ActionUnknownIntent
}

// ─── CUSTOM JSON UNMARSHALING ────────────────────────────────────────────────

// UnmarshalJSON translates the string output from the LLM back into the uint8
// values required by the REVENANT Gateway C-Struct memory layout.
func (t *ActionType) UnmarshalJSON(data []byte) error {
	// Strip quotes from the JSON string
	strData := strings.Trim(string(data), `"`)

	switch strData {
	case "TRANSFER":
		*t = ActionTransfer
	case "PAY_BILL":
		*t = ActionPayBill
	case "CARD_BLOCK":
		*t = ActionCardBlock
	case "UNKNOWN_INTENT":
		*t = ActionUnknownIntent
	default:
		return fmt.Errorf("invalid action_type string from LLM: %s", strData)
	}
	return nil
}

// ─── CURRENCY ENUM ────────────────────────────────────────────────────────────

type Currency string

const (
	CurrencyUZS Currency = "UZS"
	CurrencyUSD Currency = "USD"
	CurrencyEUR Currency = "EUR"
	CurrencyRUB Currency = "RUB"
)

var validCurrencies = map[Currency]struct{}{
	CurrencyUZS: {},
	CurrencyUSD: {},
	CurrencyEUR: {},
	CurrencyRUB: {},
}

func (c Currency) IsValid() bool {
	_, ok := validCurrencies[c]
	return ok
}

// ─── AMOUNT LIMITS (STRICTLY UINT64 TIYINS/CENTS) ─────────────────────────────
const (
	// maxTransferAmountUZS: 2,000,000,000 UZS = 200,000,000,000 Tiyins
	maxTransferAmountUZS = uint64(200_000_000_000)
	maxAmountUSD         = uint64(20_000_000)    // $200,000 = 20M Cents
	maxAmountEUR         = uint64(20_000_000)    // €200,000 = 20M Cents
	maxAmountRUB         = uint64(2_000_000_000) // ₽20M = 2B Kopecks

	maxRecipientLen   = 100
	maxDescriptionLen = 300
)

func currencyMaxAmount(c Currency) uint64 {
	switch c {
	case CurrencyUZS:
		return maxTransferAmountUZS
	case CurrencyUSD:
		return maxAmountUSD
	case CurrencyEUR:
		return maxAmountEUR
	case CurrencyRUB:
		return maxAmountRUB
	default:
		return 0
	}
}

// ─── ACTION STRUCT ────────────────────────────────────────────────────────────

// Action is the atomic unit of intent extracted from user text.
type Action struct {
	ActionType    ActionType `json:"action_type"`
	Amount        uint64     `json:"amount"` // STRICT UINT64: Tiyins/Cents only
	Currency      Currency   `json:"currency"`
	ReceiverAlias string     `json:"recipient"`
	Description   string     `json:"description"`
}

// IntentResponse is the complete structured output of one LLM inference call.
type IntentResponse struct {
	Actions []Action `json:"actions"`
}

const MaxActionsPerRequest = 8

// ─── VALIDATION ERROR ─────────────────────────────────────────────────────────

type ValidationError struct {
	RuleID  string
	Field   string
	Message string
}

func (v ValidationError) Error() string {
	return fmt.Sprintf("[%s] field=%s: %s", v.RuleID, v.Field, v.Message)
}

// ─── ACTION VALIDATION ────────────────────────────────────────────────────────

func (a *Action) Validate() []ValidationError {
	var errs []ValidationError

	if !a.ActionType.IsValid() {
		errs = append(errs, ValidationError{
			RuleID:  "SCHEMA-01",
			Field:   "action_type",
			Message: fmt.Sprintf("unknown action type %d", a.ActionType),
		})
		return errs
	}

	if !a.Currency.IsValid() {
		errs = append(errs, ValidationError{
			RuleID:  "SCHEMA-02",
			Field:   "currency",
			Message: fmt.Sprintf("unknown currency %q", a.Currency),
		})
	}

	if a.ActionType.RequiresPositiveAmount() && a.Amount == 0 {
		errs = append(errs, ValidationError{
			RuleID:  "SCHEMA-04",
			Field:   "amount",
			Message: "action requires a positive amount",
		})
	}

	if a.ActionType.MustHaveZeroAmount() && a.Amount != 0 {
		errs = append(errs, ValidationError{
			RuleID:  "SCHEMA-05",
			Field:   "amount",
			Message: "action must have amount=0 — possible hallucination",
		})
	}

	if a.Currency.IsValid() && a.Amount > 0 {
		maxAmt := currencyMaxAmount(a.Currency)
		if a.Amount > maxAmt {
			errs = append(errs, ValidationError{
				RuleID:  "SCHEMA-06",
				Field:   "amount",
				Message: fmt.Sprintf("amount %d exceeds schema ceiling %d", a.Amount, maxAmt),
			})
		}
	}

	if a.ActionType.RequiresRecipient() && strings.TrimSpace(a.ReceiverAlias) == "" {
		errs = append(errs, ValidationError{
			RuleID:  "SCHEMA-07",
			Field:   "recipient",
			Message: "action requires a non-empty recipient",
		})
	}

	if looksLikeAccountNumber(a.ReceiverAlias) {
		errs = append(errs, ValidationError{
			RuleID:  "SCHEMA-08",
			Field:   "recipient",
			Message: "recipient appears to contain a numeric account or card number",
		})
	}

	if len([]rune(a.ReceiverAlias)) > maxRecipientLen {
		errs = append(errs, ValidationError{
			RuleID:  "SCHEMA-09",
			Field:   "recipient",
			Message: fmt.Sprintf("recipient exceeds %d rune limit", maxRecipientLen),
		})
	}

	return errs
}

// ─── RESPONSE VALIDATION ─────────────────────────────────────────────────────

type ResponseValidationResult struct {
	Valid          bool
	ActionErrors   map[int][]ValidationError
	ResponseErrors []ValidationError
}

// FormatValidationErrors returns a single-line summary of validation errors
// for structured logging. Does not include the raw action data to prevent
// PII leakage from LLM outputs into log streams.
func FormatValidationErrors(result ResponseValidationResult) string {
	if result.Valid {
		return "VALID"
	}
	var parts []string
	for _, re := range result.ResponseErrors {
		parts = append(parts, re.Error())
	}
	for idx, errs := range result.ActionErrors {
		for _, e := range errs {
			parts = append(parts, fmt.Sprintf("action[%d]: %s", idx, e.Error()))
		}
	}
	return strings.Join(parts, "; ")
}

func ValidateResponse(r *IntentResponse) ResponseValidationResult {
	result := ResponseValidationResult{
		Valid:        true,
		ActionErrors: make(map[int][]ValidationError),
	}

	if r.Actions == nil {
		result.Valid = false
		result.ResponseErrors = append(result.ResponseErrors, ValidationError{
			RuleID:  "SCHEMA-R01",
			Field:   "actions",
			Message: "actions array is nil",
		})
		return result
	}

	if len(r.Actions) > MaxActionsPerRequest {
		result.Valid = false
		result.ResponseErrors = append(result.ResponseErrors, ValidationError{
			RuleID:  "SCHEMA-R02",
			Field:   "actions",
			Message: "actions count exceeds maximum",
		})
	}

	if len(r.Actions) > 1 {
		for i, a := range r.Actions {
			if a.ActionType == ActionUnknownIntent {
				result.Valid = false
				result.ResponseErrors = append(result.ResponseErrors, ValidationError{
					RuleID:  "SCHEMA-R03",
					Field:   fmt.Sprintf("actions[%d]", i),
					Message: "UNKNOWN_INTENT action must not appear alongside executable actions",
				})
			}
		}
	}

	for i := range r.Actions {
		errs := r.Actions[i].Validate()
		result.ActionErrors[i] = errs
		if len(errs) > 0 {
			result.Valid = false
		}
	}

	return result
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

func looksLikeAccountNumber(s string) bool {
	if s == "" {
		return false
	}
	consecutiveDigits := 0
	for _, r := range s {
		if r >= '0' && r <= '9' {
			consecutiveDigits++
			if consecutiveDigits >= 8 {
				return true
			}
		} else if r == ' ' || r == '-' {
			continue
		} else {
			consecutiveDigits = 0
		}
	}
	return false
}
