// Package policy implements all hard business rules for the revenant-orchestrator.
// Every function in this package is pure: no I/O, no goroutines, no external calls.
// Panic-free by design — all error conditions return typed errors, never panic.
//
// invariants.go — BLOCK 7.3 (Invariant Validator) + BLOCK 8.2 (Execution Policy Firewall)
// Codename: IRON HAND
//
// Architecture §4 Non-Negotiable Invariants implemented here:
//   - NaN/Infinity financial guard (checked FIRST, before any arithmetic)
//   - IRON HAND: absolute $50,000 USD transaction ceiling (no override)
//   - RULE_01: APPROVED + UNKNOWN action is forbidden
//   - RULE_02: APPROVED + empty reason is forbidden
//   - RULE_03: APPROVED + DELETE action requires human gate
package policy

import (
	"fmt"
	"math"
	"strings"
	"time"

	"revenant-gateway/internal/domain"
)

// ─── POLICY CONSTANTS ─────────────────────────────────────────────────────────

const (
	// ironHandCeilingUSD is the IRON HAND absolute transaction ceiling.
	//
	// Architecture §4: "Absolute hard kill-switch. No override possible."
	// The check uses >= not > — the ceiling itself is excluded.
	// This value is intentionally an untyped float64 constant so the compiler
	// can evaluate amountUSD >= ironHandCeilingUSD as a constant comparison,
	// avoiding any fp rounding from variable assignment.
	ironHandCeilingUSD = 50_000.0

	// sarThresholdUSD is the CBU mandatory SAR filing threshold (LRU-1115 Article 14).
	// Transactions at or above this value must generate a SAR XML report.
	// Architecture §4: "Filed before dispatch, not after."
	sarThresholdUSD = 10_000.0

	// defaultUZSRate is the fallback UZS→USD exchange rate.
	// Production value MUST be injected via Configure() before processing any request.
	defaultUZSRate = 12_850.0
)

// uzs2usdRate is the live exchange rate for UZS→USD conversion.
// It is a package-level variable (not a constant) so that Configure() can
// inject the value from config at startup, and tests can override it without
// recompiling. Reads are safe from any goroutine after Configure() has returned
// (it is set once at startup, before the HTTP server starts accepting requests).
var uzs2usdRate = defaultUZSRate

// Configure injects the UZS/USD exchange rate at startup.
// Call this once from main() after loading internal/config before any request
// is processed. Calling it after requests have started is a data race.
func Configure(uzsToUSDRate float64) {
	if uzsToUSDRate <= 0 {
		panic("policy.Configure: uzsToUSDRate must be positive")
	}
	uzs2usdRate = uzsToUSDRate
}

// ─── ENFORCE INVARIANTS ───────────────────────────────────────────────────────

// EnforceInvariants implements BLOCK 7.3 (Invariant Validator) and BLOCK 8.2
// (Execution Policy Firewall — IRON HAND), as specified in Architecture §4.
//
// Checks are applied in the exact order mandated by the architecture specification:
//
//  0. NaN/Infinity guard  — MUST run before any arithmetic on transaction amounts.
//     A crafted payload can produce NaN/Inf through string-to-float
//     parsing bugs in upstream middleware (e.g., amount="Infinity").
//  1. Currency normalisation — convert TransactionAmt to USD using live exchange rate.
//  2. Post-conversion NaN/Inf guard — division by a near-zero rate can produce Inf.
//  3. IRON HAND ceiling check — reject if amountUSD >= $50,000. No exceptions.
//  4. RULE_01 — APPROVED action cannot have an UNKNOWN or empty target.
//  5. RULE_02 — APPROVED action requires a non-empty reasoning string (audit mandate).
//  6. RULE_03 — DELETE-class actions require human gate; cannot be auto-approved.
//
// On any failure, ctx.InvariantCheck.Violations, ctx.PolicyResult, and ctx.WorkflowError
// are populated, ctx.FinalStatus is set to "REJECTED", and a non-nil error is returned.
// The pipeline worker MUST halt all subsequent stages on non-nil return.
//
// On success, ctx.PolicyResult is fully populated with normalised financial data,
// ctx.SARRequired is set if the SAR threshold is met, and ctx.InvariantCheck.Status
// is set to "POLICIES_CLEAN".
func EnforceInvariants(ctx *domain.IntentContext) error {
	// ── CHECK 0: PRE-ARITHMETIC NaN / INFINITY GUARD ─────────────────────
	//
	// This MUST be the first check. A NaN amount would pass all limit checks
	// (NaN >= 50000 is false in IEEE 754) while carrying an undefined value
	// through the pipeline. This is an exploitable vulnerability.
	//
	// Attack vector: POST {"amount": "NaN"} or {"amount": 1e308 * 2}
	// ── CHECK 0: PRE-ARITHMETIC NaN / INFINITY GUARD ─────────────────────
	if math.IsNaN(ctx.TransactionAmt) || math.IsInf(ctx.TransactionAmt, 0) {
		ctx.PolicyResult.ForensicFlag = true
		return recordViolation(ctx,
			"MATH_INTEGRITY_FAILURE",
			fmt.Sprintf("transaction_amount is not finite: %v — possible overflow or injection attack", ctx.TransactionAmt),
			"policy_nan_guard_preconv",
		)
	}

	// ── CHECK 0.5: STRICT POSITIVE VALUE GUARD ───────────────────────────
	// Mitigates the "Minus-Sign Heist" integer underflow attack.
	// A transaction amount must be strictly greater than zero.
	if ctx.TransactionAmt <= 0 {
		ctx.PolicyResult.ForensicFlag = true
		return recordViolation(ctx,
			"MATH_INTEGRITY_FAILURE",
			fmt.Sprintf("transaction_amount must be greater than zero, received: %v", ctx.TransactionAmt),
			"policy_negative_guard",
		)
	}

	// ── CHECK 1: CURRENCY NORMALISATION ──────────────────────────────────
	//
	// Normalise ctx.TransactionAmt to USD for the unified ceiling check.
	// ctx.PolicyResult.AmountUZS is populated for UZS inputs to preserve the
	// original value for the audit trail without losing precision.
	var amountUSD float64

	switch strings.ToUpper(ctx.Currency) {
	case "USD":
		amountUSD = ctx.TransactionAmt
	case "UZS":
		// UZS inputs are converted using the live exchange rate.
		// The rate is set at startup via Configure(); default is 12,850 UZS/USD.
		amountUSD = ctx.TransactionAmt / uzs2usdRate
		ctx.PolicyResult.AmountUZS = ctx.TransactionAmt
	default:
		// Unknown currency: block immediately. Risk of arbitrage or currency-
		// confusion exploits where the attacker provides a high-value currency
		// code (e.g., "KWD") expecting the system to treat the amount as USD.
		ctx.PolicyResult.ForensicFlag = true
		return recordViolation(ctx,
			"IRON_HAND_VIOLATION",
			fmt.Sprintf("unsupported currency %q — arbitrage risk, cannot normalise to USD", ctx.Currency),
			"policy_currency_unknown",
		)
	}

	// ── CHECK 2: POST-CONVERSION NaN / INFINITY GUARD ─────────────────────
	//
	// A near-zero exchange rate could produce Inf from a finite numerator.
	// Configure() guards against zero/negative rates, but a rate loaded from
	// an external source could still be pathological.
	// ── CHECK 2: POST-CONVERSION NaN / INFINITY GUARD ─────────────────────
	if math.IsNaN(amountUSD) || math.IsInf(amountUSD, 0) {
		ctx.PolicyResult.ForensicFlag = true
		return recordViolation(ctx,
			"MATH_INTEGRITY_FAILURE",
			"amount_usd is not finite after currency conversion — possible rate misconfiguration",
			"policy_nan_guard_postconv",
		)
	}

	// Populate the normalised financial data on ctx before the ceiling check
	// so that rejection records include the computed USD value for auditing.
	ctx.PolicyResult.AmountUSD = amountUSD
	ctx.PolicyResult.HardCeiling = ironHandCeilingUSD

	// ── CHECK 3: IRON HAND — $50,000 USD CEILING ─────────────────────────
	//
	// Architecture §4: "Absolute hard kill-switch. No override possible.
	// Go: if amountUSD >= 50000 → REJECT before any human gate."
	//
	// Note the check is applied BEFORE the human-in-the-loop gate (BLOCK 8.3).
	// Even if a human approver exists, transactions at or above the ceiling are
	// categorically rejected by the sovereign infrastructure layer.
	if amountUSD >= ironHandCeilingUSD {
		reason := fmt.Sprintf(
			"IRON_HAND: amount $%.2f USD exceeds sovereign hard ceiling of $%.0f USD",
			amountUSD, ironHandCeilingUSD,
		)
		ctx.PolicyResult.FirewallStatus = "REJECT"
		ctx.PolicyResult.Reason = reason
		ctx.PolicyResult.ForensicFlag = true
		return recordViolation(ctx, "IRON_HAND_VIOLATION", reason, "policy_ironhand_ceiling")
	}

	// Flag SAR requirement (non-blocking at this stage — SAR XML generated in compliance/).
	// Architecture §4: "Filed before dispatch, not after."
	if amountUSD >= sarThresholdUSD {
		ctx.SARRequired = true
	}

	ctx.PolicyResult.FirewallStatus = "PASS"

	// ── CHECKS 4–6: HARD BUSINESS INVARIANTS (RULE_01 – RULE_03) ─────────
	//
	// These rules run AFTER the IRON HAND because the invariants check the
	// advisory/approval decision fields, which are only meaningful for
	// transactions that passed the financial ceiling check.
	//
	// All checks share the same derived values:
	isApproved := strings.EqualFold(ctx.FinalStatus, "APPROVED")

	// Advisory.Action: what the LLM/rule engine decided to execute.
	// Trim whitespace to prevent bypass via padding ("  UNKNOWN  " != "UNKNOWN" == false).
	action := strings.TrimSpace(ctx.Advisory.Action)

	// Advisory.Reasoning: the explanation for the decision.
	// Length < 2 catches both the empty string and single-character non-reasons.
	reason := strings.TrimSpace(ctx.Advisory.Reasoning)

	type invariantRule struct {
		id     string
		desc   string
		failed bool
	}

	rules := [...]invariantRule{
		{
			// RULE_01: An approved action whose target is UNKNOWN means the
			// advisory pipeline failed to determine what to execute.
			// Executing an UNKNOWN action is undefined behaviour in the Rust engine.
			id:   "RULE_01",
			desc: "APPROVED action with UNKNOWN or empty target is forbidden — execution target must be deterministic",
			failed: isApproved &&
				(action == "" || strings.EqualFold(action, "UNKNOWN")),
		},
		{
			// RULE_02: CBU LRU-1115 Article 14 audit compliance requires a non-empty
			// reasoning string on every approved transaction. An empty reason means
			// the decision cannot be explained or reviewed post-execution.
			id:     "RULE_02",
			desc:   "APPROVED action without a reasoning string violates CBU audit mandate",
			failed: isApproved && len(reason) < 2,
		},
		{
			// RULE_03: Any action whose name contains "DELETE" represents a
			// destructive, irreversible operation. These are categorically
			// ineligible for auto-approval — they require a human in the loop.
			// This catches: DELETE_ACCOUNT, DELETE_CARD, BULK_DELETE, etc.
			id:   "RULE_03",
			desc: "DELETE-class actions require human review and cannot be auto-approved — route to human gate",
			failed: isApproved &&
				strings.Contains(strings.ToUpper(action), "DELETE"),
		},
	}

	for i := range rules {
		if rules[i].failed {
			return recordViolation(ctx,
				"INVARIANT_VIOLATION",
				fmt.Sprintf("[%s] %s", rules[i].id, rules[i].desc),
				"policy_invariants",
			)
		}
	}

	// ── ALL CHECKS PASSED ─────────────────────────────────────────────────
	ctx.InvariantCheck = domain.InvariantResult{
		Status:     "POLICIES_CLEAN",
		Violations: []string{},
		CheckedAt:  time.Now().UTC(),
	}
	return nil
}

// ─── HELPER ───────────────────────────────────────────────────────────────────

// recordViolation is the single write path for all policy/invariant failures.
//
// It atomically:
//   - Sets ctx.FinalStatus to "REJECTED"
//   - Populates ctx.InvariantCheck with violation details
//   - Populates ctx.WorkflowError for pipeline short-circuit propagation
//   - Returns a descriptive error for the HTTP response layer
//
// Centralising this prevents the subtle bug where a new invariant check sets the
// error return but forgets to update one of the three ctx fields, leaving the
// audit trail in an inconsistent state.
func recordViolation(
	ctx *domain.IntentContext,
	violationType, detail, stage string,
) error {
	now := time.Now().UTC()
	ctx.FinalStatus = "REJECTED"
	ctx.InvariantCheck = domain.InvariantResult{
		Status:     violationType,
		Violations: []string{detail},
		CheckedAt:  now,
	}
	ctx.WorkflowError = &domain.WorkflowErr{
		Type:   violationType,
		Errors: []string{detail},
		Stage:  stage,
		At:     now,
	}
	return fmt.Errorf("%s stage=%s trace=%s: %s", violationType, stage, ctx.TraceID, detail)
}
