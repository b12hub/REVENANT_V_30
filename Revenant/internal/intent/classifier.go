// Package intent implements all deterministic NLP classification for the
// revenant-orchestrator. No I/O, no external calls, no allocations on the hot path
// beyond the IntentContext fields being written.
//
// classifier.go — BLOCK 1: Text Feature Engineering + Rule-Based Severity Classifier
// Source nodes: Text Feature Engineering V26, Rule-Based Severity Classifier V22,
//
//	Language Detection Engine V20.
package intent

import (
	"regexp"
	"strings"
	"time"
	"unicode"

	"revenant-gateway/internal/domain"
)

// ─── PII & FEATURE REGEXES ────────────────────────────────────────────────────
//
// Compiled once at package init. All patterns are anchored or use word boundaries
// to minimise false positives. MustCompile panics at startup on malformed patterns.
var (
	// UzCard (8600 prefix) and Humo (5614 prefix): 16-digit card numbers.
	// The \b anchors prevent matching card numbers embedded in longer digit strings.
	rePIICard = regexp.MustCompile(`\b(8600|5614)\d{12}\b`)

	// Uzbek mobile phone numbers: +998 followed by exactly 9 digits.
	rePIIPhone = regexp.MustCompile(`\+998\d{9}`)

	// Generic account/transaction numbers: 16–20 consecutive digits.
	// Catches account numbers that don't match the card prefix patterns.
	rePIIAccountNum = regexp.MustCompile(`\b\d{16,20}\b`)

	// HTTP error codes inline with "error": "error 404", "error 500", etc.
	reErrorCode = regexp.MustCompile(`(?i)\berror\s+(4\d{2}|5\d{2})\b|timeout|database\s+error`)

	// Critical operational keywords (Uzbek, Russian, English).
	// Each match increments the CRITICAL score by WEIGHT_CRITICAL_INDICATOR (3.5).
	reCritical = regexp.MustCompile(
		`(?i)\b(outage|down|breach|loss|emergency|ishlamayapti|` +
			`отключен|критическая|critical|system\s+failure|data\s+loss)\b`)

	// High-priority operational keywords.
	// Each match increments the HIGH score by WEIGHT_HIGH_INDICATOR (2.0).
	reHigh = regexp.MustCompile(
		`(?i)\b(failed|cannot|unable|error|urgent|tezda|` +
			`сброс|ошибка|bloklash|muammo|не\s+работает)\b`)

	// ─── LANGUAGE DETECTION ──────────────────────────────────────────────────

	// Uzbek Latin: high-frequency stop words and morphological suffixes.
	// The morphological ending pattern (-lar plural, -gan past participle, -moqda progressive)
	// is specific to Uzbek and rarely appears in English or Russian Latin transliteration.
	reUzbekStrong = regexp.MustCompile(
		`(?i)\b(iltimos|rahmat|yordam|muammo|tizim|hisob|to'lov|` +
			`ishlamayapti|shaxsiy|kabinet|tadbirkor|pul|o'tkazma|` +
			`bilan|uchun|kerak|yoki|esa|qilish|balans|qancha)\b`)
	reUzbekMorphology = regexp.MustCompile(`\b\w+(lar|gan|moqda|dagi)\b`)

	// Russian: high-frequency banking/support stop words in Cyrillic.
	reRussianStrong = regexp.MustCompile(
		`(?i)\b(пожалуйста|спасибо|проблема|оплата|ошибка|` +
			`доступ|кабинет|мерчант|вход|перевод|баланс|` +
			`не\s+работает|счёт|блокировка)\b`)
)

// ─── SCORING WEIGHTS ──────────────────────────────────────────────────────────
//
// These constants mirror the n8n Rule-Based Severity Classifier V22 WEIGHTS object.
// Exported as typed constants so downstream tests can verify expected score sums.
const (
	weightCriticalIndicator = 3.5 // CRITICAL_INDICATOR
	weightHighIndicator     = 2.0 // HIGH_INDICATOR
	weightErrorCodeMatch    = 1.5 // ERROR_CODE_MATCH
	weightIntentEscalation  = 2.5 // INTENT_ESCALATION (merchant + access_issue cross-ref)
	weightFeatureCritical   = 2.0 // added to critical score when HasCritical is true
	weightFeatureErrorCode  = 1.5 // added to high score when HasErrorCode is true
)

// ─── SEVERITY THRESHOLDS ──────────────────────────────────────────────────────
const (
	thresholdCritical = 3.0
	thresholdHigh     = 2.0
	thresholdMedium   = 1.0
)

// ─── INTENT KEYWORD SCORING MATRIX ───────────────────────────────────────────
//
// Each intentDef maps an intent label to its trigger keywords.
// Lower-cased at definition time so the hot-path loop avoids ToLower per check.
// Ordered from most- to least-specific to short-circuit quickly on the common cases.
// Source: n8n Text Feature Engineering V26 intents object.
type intentDef struct {
	label    string
	keywords []string
}

var intentMatrix = [...]intentDef{
	{
		label: "SECURITY_ALERT",
		// Highest specificity — security events must be caught before fraud
		// to avoid misclassifying an attack as a routine complaint.
		keywords: []string{
			"replay", "attack", "injection", "vulnerability",
			"xss", "sqli", "mitm", "ddos", "brute force",
			"o'g'irlangan", // Uzbek: "stolen" (security context)
		},
	},
	{
		label: "FRAUD_REPORT",
		keywords: []string{
			"scam", "fraud", "hacked", "stolen", "phishing",
			"o'girlangan", "firibgar", // Uzbek: "scammer"
			"мошенник", "обман", // Russian: "fraudster", "deception"
		},
	},
	{
		label: "CARD_BLOCK",
		keywords: []string{
			"block", "freeze", "lost card", "lost my card",
			"yo'qolgan", "bloklash", "stop card",
			"заблокировать", "потерял карту", // Russian
		},
	},
	{
		label: "TRANSFER_ISSUE",
		keywords: []string{
			"transfer", "sent", "money", "payment", "pending",
			"pul", "o'tkazma", "yetib bormadi", // Uzbek: "money", "transfer", "didn't arrive"
			"перевод", "не дошло", // Russian: "transfer", "didn't arrive"
		},
	},
	{
		label: "BALANCE_INQUIRY",
		keywords: []string{
			"balance", "how much", "account total",
			"balans", "qancha", "qolgan", // Uzbek: "balance", "how much", "remaining"
			"баланс", "сколько", // Russian
		},
	},
	// GENERAL_INQUIRY is the default and has no keywords.
}

// ─── CLASSIFY INTENT ─────────────────────────────────────────────────────────

// ClassifyIntent is the pipeline Stage 1 entry point.
//
// It is the Go equivalent of three n8n nodes run in sequence:
//  1. Text Feature Engineering V26  → ctx.TextFeatures
//  2. Language Detection Engine V20 → ctx.LangAnalysis
//  3. Rule-Based Severity Classifier V22 → ctx.Severity
//
// The combined result is also written to ctx.RuleEngine (IntentResult) with
// Source = "RULE_ENGINE" so that the Pre-Fusion Normalizer (Stage 2) can compare
// it against the LLM advisory with full provenance.
//
// ClassifyIntent never returns an error. Classification always produces a result;
// the fallback intent is GENERAL_INQUIRY with 0.5 confidence (deterministic default).
func ClassifyIntent(ctx *domain.IntentContext) {
	// Build the combined text surface once. All subsequent operations read this.
	// Use ToLower so all keyword comparisons are case-insensitive without
	// converting the original ctx fields.
	text := strings.ToLower(ctx.Subject + " " + ctx.Body)
	now := time.Now().UTC()

	// ── STAGE 1: FEATURE EXTRACTION ──────────────────────────────────────
	ctx.TextFeatures = extractFeatures(text, ctx.TransactionAmt)

	// ── STAGE 2: LANGUAGE DETECTION ──────────────────────────────────────
	ctx.LangAnalysis = detectLanguage(text, ctx.Subject+" "+ctx.Body)

	// ── STAGE 3: INTENT CLASSIFICATION ───────────────────────────────────
	intent, confidence := classifyIntent(text)
	ctx.RuleEngine = domain.IntentResult{
		Intent:     intent,
		Confidence: confidence,
		Severity:   intentBaseSeverity(intent, ctx.TransactionAmt, ctx.TextFeatures),
		Source:     "RULE_ENGINE",
		DetectedAt: now,
	}

	// ── STAGE 4: WEIGHTED SEVERITY SCORING ───────────────────────────────
	// The rule-based severity classifier runs AFTER intent classification so it
	// can cross-reference the detected intent (e.g., merchant + access_issue
	// escalation in INTENT_ESCALATION weight).
	ctx.Severity = classifySeverity(text, ctx.RuleEngine.Intent, ctx.TextFeatures)
}

// ─── FEATURE EXTRACTION ──────────────────────────────────────────────────────

// extractFeatures performs PII and keyword detection on the lowercased combined text.
// Returns a fully populated FeatureSet with boolean flags.
//
// PII patterns are sourced from the UZB-market compliance spec (Architecture §3):
//   - UzCard/Humo card numbers (8600/5614 prefix)
//   - Uzbek mobile numbers (+998 prefix)
//   - Generic account numbers (16–20 digits)
func extractFeatures(textLower string, transactionAmt float64) domain.FeatureSet {
	return domain.FeatureSet{
		HasCardNumber:    rePIICard.MatchString(textLower),
		HasPhoneNumber:   rePIIPhone.MatchString(textLower),
		HasAccountNumber: rePIIAccountNum.MatchString(textLower),

		HasCryptoTerms: containsAny(textLower,
			"crypto", "bitcoin", "btc", "usdt", "binance", "tether", "ethereum"),

		HasUrgentKeywords: containsAny(textLower,
			"immediately", "asap", "urgent", "tezda", "fast", "right now", "zudlik bilan"),

		HasSecurityTerms: containsAny(textLower,
			"hack", "stolen", "fraud", "replay", "attack", "injection", "exploit"),

		HasCritical:  reCritical.MatchString(textLower),
		HasErrorCode: reErrorCode.MatchString(textLower),
	}
}

// ─── INTENT CLASSIFICATION ───────────────────────────────────────────────────

// classifyIntent scores the text against each intent's keyword set and returns
// the highest-scoring intent label and its confidence value.
//
// Scoring is deterministic: confidence = 1.0 if any keyword matched, 0.5 otherwise.
// The n8n original used: `confidence: maxScore > 0 ? 1.0 : 0.5`
func classifyIntent(textLower string) (intent string, confidence float64) {
	bestLabel := "GENERAL_INQUIRY"
	bestScore := 0

	for i := range intentMatrix {
		score := 0
		for _, kw := range intentMatrix[i].keywords {
			if strings.Contains(textLower, kw) {
				score++
			}
		}
		// Strict >: on a tie, the earlier (more specific) intent wins.
		if score > bestScore {
			bestScore = score
			bestLabel = intentMatrix[i].label
		}
	}

	if bestScore > 0 {
		return bestLabel, 1.0
	}
	return bestLabel, 0.5
}

// intentBaseSeverity derives the initial severity from intent and contextual signals.
// This mirrors the Text Feature Engineering V26 severity calculation:
//
//	SECURITY_ALERT | FRAUD_REPORT → critical
//	CARD_BLOCK                    → high
//	amount > 10,000 || urgent     → high
//	TRANSFER_ISSUE                → medium
//	default                       → low
func intentBaseSeverity(intent string, amount float64, feat domain.FeatureSet) string {
	switch intent {
	case "SECURITY_ALERT", "FRAUD_REPORT":
		return "critical"
	case "CARD_BLOCK":
		return "high"
	case "TRANSFER_ISSUE":
		if amount > 10_000 || feat.HasUrgentKeywords {
			return "high"
		}
		return "medium"
	default:
		if amount > 10_000 || feat.HasUrgentKeywords {
			return "high"
		}
		return "low"
	}
}

// ─── LANGUAGE DETECTION ──────────────────────────────────────────────────────

// detectLanguage returns a LanguageResult using pattern-scoring heuristics.
// No external library is used — the detector is optimised for the three languages
// active in the Uzbekistan banking market: Uzbek (Latin), Russian (Cyrillic), English.
//
// Detection strategy:
//  1. Count Cyrillic runes in the raw (mixed-case) text → Russian signal
//  2. Match Uzbek stop words and morphological endings → Uzbek signal
//  3. English is the fallback when neither signal dominates
func detectLanguage(textLower, textRaw string) domain.LanguageResult {
	if strings.TrimSpace(textRaw) == "" {
		return domain.LanguageResult{
			Detected:   "unknown",
			Confidence: 0,
			Status:     "MISSING_TEXT_FOR_ANALYSIS",
		}
	}

	// Count Cyrillic runes: a high Cyrillic ratio is a strong Russian signal.
	totalRunes, cyrillicRunes := 0, 0
	for _, r := range textRaw {
		if !unicode.IsSpace(r) && !unicode.IsPunct(r) {
			totalRunes++
			if unicode.In(r, unicode.Cyrillic) {
				cyrillicRunes++
			}
		}
	}

	var cyrillicRatio float64
	if totalRunes > 0 {
		cyrillicRatio = float64(cyrillicRunes) / float64(totalRunes)
	}

	// Russian: >40% Cyrillic runes OR strong Cyrillic keyword match.
	if cyrillicRatio > 0.40 || reRussianStrong.MatchString(textLower) {
		conf := 0.6 + cyrillicRatio*0.4 // 0.6–1.0 depending on Cyrillic density
		if conf > 0.98 {
			conf = 0.98
		}
		return domain.LanguageResult{Detected: "ru", Confidence: conf, Status: "DETECTED"}
	}

	// Uzbek: strong stop word match OR morphological suffix match.
	uzScore := 0
	if reUzbekStrong.MatchString(textLower) {
		uzScore += 2
	}
	if reUzbekMorphology.MatchString(textLower) {
		uzScore++
	}
	if uzScore >= 2 {
		conf := 0.5 + float64(uzScore)*0.1
		if conf > 0.98 {
			conf = 0.98
		}
		return domain.LanguageResult{Detected: "uz", Confidence: conf, Status: "DETECTED"}
	}

	// English: default fallback. Lower confidence since we didn't positively identify it.
	return domain.LanguageResult{Detected: "en", Confidence: 0.5, Status: "FALLBACK_ENGLISH"}
}

// ─── WEIGHTED SEVERITY CLASSIFIER ────────────────────────────────────────────

// classifySeverity implements the Rule-Based Severity Classifier V22.
//
// Multi-factor weighted scoring:
//   - Critical keyword match  → +3.5 to critical score
//   - High keyword match      → +2.0 to high score
//   - Technical error code    → +1.5 to high score
//   - HasCritical flag        → +2.0 to critical score (cross-node intelligence)
//   - HasErrorCode flag       → +1.5 to high score (cross-node intelligence)
//   - access_issue + merchant → +2.5 to high score (INTENT_ESCALATION)
//
// Final selection thresholds:
//
//	critical ≥ 3.0 → "critical"
//	high     ≥ 2.0 → "high"
//	medium   ≥ 1.0 → "medium"
//	default        → "low"
func classifySeverity(textLower, intent string, feat domain.FeatureSet) domain.SeverityResult {
	scores := map[string]float64{
		"critical": 0,
		"high":     0,
		"medium":   0,
		"low":      0,
	}

	// Pattern-based scoring
	if reCritical.MatchString(textLower) {
		scores["critical"] += weightCriticalIndicator
	}
	if reHigh.MatchString(textLower) {
		scores["high"] += weightHighIndicator
	}
	if reErrorCode.MatchString(textLower) {
		scores["high"] += weightErrorCodeMatch
	}

	// Cross-node feature intelligence (Architecture §1, Text Feature Engineering)
	if feat.HasCritical {
		scores["critical"] += weightFeatureCritical
	}
	if feat.HasErrorCode {
		scores["high"] += weightFeatureErrorCode
	}

	// Intent escalation: an access/merchant issue is elevated to HIGH
	// regardless of the keyword score (INTENT_ESCALATION = 2.5).
	if intent == "TRANSFER_ISSUE" &&
		(strings.Contains(textLower, "merchant") || strings.Contains(textLower, "merchant")) {
		scores["high"] += weightIntentEscalation
	}

	// Deterministic selection from scored categories
	level := "low"
	switch {
	case scores["critical"] >= thresholdCritical:
		level = "critical"
	case scores["high"] >= thresholdHigh:
		level = "high"
	case scores["medium"] >= thresholdMedium:
		level = "medium"
	}

	// Confidence formula from n8n V22: min(0.98, 0.4 + maxScore/10)
	maxScore := 0.0
	for _, v := range scores {
		if v > maxScore {
			maxScore = v
		}
	}
	confidence := 0.4 + maxScore/10
	if confidence > 0.98 {
		confidence = 0.98
	}

	return domain.SeverityResult{
		Level:      level,
		Confidence: roundFloat(confidence, 2),
		Scores:     scores,
	}
}

// ─── UTILITIES ────────────────────────────────────────────────────────────────

// containsAny returns true if textLower contains any of the provided substrings.
// All needles must already be lowercase (this is not enforced — caller's contract).
func containsAny(textLower string, needles ...string) bool {
	for _, n := range needles {
		if strings.Contains(textLower, n) {
			return true
		}
	}
	return false
}

// roundFloat rounds f to d decimal places without importing math/big.
// Used only for confidence scores where 2 decimal places is the n8n spec.
func roundFloat(f float64, d int) float64 {
	pow := 1.0
	for i := 0; i < d; i++ {
		pow *= 10
	}
	return float64(int(f*pow+0.5)) / pow
}
