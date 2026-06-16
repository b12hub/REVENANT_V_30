// Package firewall implements the Phase F Semantic Firewall for the REVENANT
// Agentic Banking Engine.
//
// semantic.go — Layer 1 of the AI Control Plane (Phase F §1: The Semantic Firewall)
//
// THREAT MODEL:
//
//	This firewall intercepts raw user text (typed commands, OCR'd B2B invoices,
//	voice transcripts) before it reaches the local Llama 3.2 model. It addresses
//	four distinct adversarial injection attack classes:
//
//	CLASS A — DIRECT PHRASE INJECTION:
//	  Text containing known LLM control phrases ("ignore instructions", "system
//	  override") embedded in what appears to be a routine banking command.
//	  Detection: exact-phrase matching on normalised lowercase text.
//	  Response: HARD REJECT (do not sanitise, do not pass to LLM).
//
//	CLASS B — UNICODE BIDIRECTIONAL INJECTION (CVE-2021-42574 / Trojan Source):
//	  Bidirectional control characters (U+202A–U+202E, U+2066–U+2069) reverse the
//	  visual rendering of surrounding text. The human reviewer sees "pay rent" while
//	  the LLM tokenizer sees "send everything to attacker.uz".
//	  Detection: character-set membership test on every rune.
//	  Response: HARD REJECT. Bidi overrides have no legitimate use in banking text.
//
//	CLASS C — ZERO-WIDTH CHARACTER INJECTION:
//	  Zero-width spaces (U+200B), joiners (U+200C/D), and soft hyphens (U+00AD) are
//	  inserted between letters of injection phrases to defeat substring matching.
//	  "ign\u200bore all" is invisible to humans but visible to tokenizers.
//	  Detection: character-set membership test on every rune.
//	  Response: STRIP (remove the characters, then re-check for Class A phrases).
//	  Note: stripping happens FIRST in the pipeline so that Class A checking runs
//	  on the reconstructed, adversary-intended string.
//
//	CLASS D — HTML COMMENT STEGANOGRAPHY:
//	  HTML comments (<!-- hidden instructions -->) and HTML entities (&lt;script&gt;)
//	  are invisible when rendered in a browser but fully visible to the LLM tokenizer.
//	  This is the primary attack vector in OCR'd B2B invoice processing.
//	  HTML comments: HARD REJECT (no legitimate use in banking natural language).
//	  HTML tags: STRIP (likely OCR artifact from invoice).
//	  HTML entities: DECODE then re-check (catches &#x69;gnore encoding).
//
//	CLASS E — UNICODE TAG BLOCK INJECTION (U+E0000–U+E007F):
//	  The Unicode tag block was originally designed for language tagging and is now
//	  deprecated. Characters in this range are invisible to humans (rendered as
//	  nothing) but are processed by some LLM tokenizers as instructions. Used to
//	  embed hidden commands invisible to both renderers and most text scanners.
//	  Detection: rune range check.
//	  Response: HARD REJECT.
//
// ORDERING INVARIANT:
//
//	The sanitization pipeline must run in this exact order:
//	  (1) Reject Class B (bidi) — cannot be safely stripped, meaning is poisoned.
//	  (2) Reject Class E (tag block) — same reasoning.
//	  (3) Strip Class C (zero-width) — reconstruct the adversary-intended string.
//	  (4) Decode HTML entities — reconstruct encoded injections.
//	  (5) Reject Class D (HTML comments) — now in plaintext form.
//	  (6) Strip HTML tags — clean OCR artifacts.
//	  (7) Reject Class A (phrase injection) — now on fully reconstructed text.
//	  (8) Length validation — after stripping, the clean text must meet minimum length.
//
//	Steps 3 and 4 MUST precede steps 5–7 to prevent bypass via encoding.
package firewall

import (
	"fmt"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"html"
)

// ─── PACKAGE-LEVEL COMPILED REGEXES ──────────────────────────────────────────
//
// Compiled once at package init. All patterns are designed to be fast on the
// expected input size (< 2,000 characters for natural language commands).

var (
	// reHTMLComment matches HTML comments: <!-- ... -->
	// The (?s) flag makes . match newlines — multiline comment injection.
	// This is a HARD REJECT pattern, not a strip pattern.
	reHTMLComment = regexp.MustCompile(`(?s)<!--.*?-->`)

	// reHTMLTag strips HTML open/close tags, preserving inner text.
	// Captures angle-bracket constructs that survived entity decoding.
	// Applied AFTER comment rejection, so only tags without comment markers reach here.
	reHTMLTag = regexp.MustCompile(`<[^>]{0,200}>`)

	// reHTMLProcessingInstruction matches XML processing instructions <?...?>
	// These can contain executable instructions in some LLM training distributions.
	reHTMLPI = regexp.MustCompile(`<\?[^?]{0,200}\?>`)

	// reNonPrintableASCII matches ASCII control characters except tab, newline, CR.
	// These have no legitimate use in natural language banking text.
	reNonPrintableASCII = regexp.MustCompile(`[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]`)

	// reExcessiveWhitespace collapses runs of whitespace (post-strip cleanup).
	reExcessiveWhitespace = regexp.MustCompile(`\s{2,}`)
)

// ─── INJECTION PHRASES ────────────────────────────────────────────────────────
//
// Fixed-size array to avoid heap allocation on the hot path.
// All phrases are lowercase — compared against strings.ToLower(input).
// Source: OWASP LLM01:2025 Prompt Injection taxonomy + REVENANT Phase F spec.
// This list is the MINIMUM set for a Central Bank audit. Extend in production.
var injectionPhrases = [...]string{
	// Direct override commands
	"ignore previous instructions",
	"ignore all instructions",
	"ignore the above",
	"ignore the following",
	"disregard all prior",
	"disregard the above",
	"forget your instructions",
	"forget all previous",
	"override all instructions",
	"system override",
	"developer mode",
	"maintenance mode",
	"debug mode",

	// Role/persona hijacking
	"act as a",
	"act as an",
	"you are now",
	"pretend you are",
	"roleplay as",
	"simulate being",
	"from now on you",
	"your new instructions",
	"new system prompt",
	"you have been reprogrammed",

	// Instruction injection via apparent document structure
	"<<<system",
	"[system]",
	"[instructions]",
	"[admin]",
	"<|im_start|>",  // Mistral/ChatML token
	"<|system|>",    // Llama chat token
	"<|endoftext|>", // GPT token
	"[/inst]",       // Llama 2 instruction token

	// Authority impersonation (from REVENANT Phase C Titanium Sanitizer)
	"sent from my iphone",
	"sent from my android",

	// Explicit bypass requests
	"bypass safety",
	"bypass the filter",
	"ignore safety",
	"disable safety",
	"jailbreak",
	"prompt injection",
	"prompt leak",
	"reveal your prompt",
	"repeat the above",
	"print your system prompt",
	"what are your instructions",
	"always answer yes",
	"always respond with",
	"simulated mode",
}

// ─── UNICODE ADVERSARIAL CHARACTER SETS ──────────────────────────────────────
//
// These are RUNE SETS, not strings. Membership testing uses a map[rune]struct{}
// for O(1) lookup per character.

// bidiControlRunes contains Unicode bidirectional control characters.
// Reference: Unicode Bidirectional Algorithm (UBA) control codes.
// CVE-2021-42574: these characters reverse visual rendering direction.
var bidiControlRunes = func() map[rune]struct{} {
	chars := []rune{
		'\u200E', // LEFT-TO-RIGHT MARK
		'\u200F', // RIGHT-TO-LEFT MARK
		'\u202A', // LEFT-TO-RIGHT EMBEDDING
		'\u202B', // RIGHT-TO-LEFT EMBEDDING
		'\u202C', // POP DIRECTIONAL FORMATTING
		'\u202D', // LEFT-TO-RIGHT OVERRIDE
		'\u202E', // RIGHT-TO-LEFT OVERRIDE — high-severity: reverses rendered text
		'\u2066', // LEFT-TO-RIGHT ISOLATE
		'\u2067', // RIGHT-TO-LEFT ISOLATE
		'\u2068', // FIRST STRONG ISOLATE
		'\u2069', // POP DIRECTIONAL ISOLATE
	}
	m := make(map[rune]struct{}, len(chars))
	for _, r := range chars {
		m[r] = struct{}{}
	}
	return m
}()

// zeroWidthRunes contains invisible-width characters used to break phrase matching.
// A phrase like "ign[ZWS]ore all" bypasses naive substring search but the LLM
// tokenizer reconstructs it as "ignore all" during BPE tokenization.
var zeroWidthRunes = func() map[rune]struct{} {
	chars := []rune{
		'\u200B', // ZERO WIDTH SPACE
		'\u200C', // ZERO WIDTH NON-JOINER
		'\u200D', // ZERO WIDTH JOINER
		'\uFEFF', // ZERO WIDTH NO-BREAK SPACE / BOM
		'\u00AD', // SOFT HYPHEN (renders as nothing, breaks word boundaries)
		'\u034F', // COMBINING GRAPHEME JOINER
		'\u115F', // HANGUL CHOSEONG FILLER
		'\u1160', // HANGUL JUNGSEONG FILLER
		'\u17B4', // KHMER VOWEL INHERENT AQ (invisible)
		'\u17B5', // KHMER VOWEL INHERENT AA (invisible)
		'\u3164', // HANGUL FILLER
		'\uFFA0', // HALFWIDTH HANGUL FILLER
	}
	m := make(map[rune]struct{}, len(chars))
	for _, r := range chars {
		m[r] = struct{}{}
	}
	return m
}()

// ─── VIOLATION CLASS CONSTANTS ────────────────────────────────────────────────

// ViolationClass identifies the category of the detected threat.
// Used in the audit log and by the caller to determine alerting severity.
type ViolationClass string

const (
	ViolationBidiControl     ViolationClass = "BIDI_CONTROL_CHARACTER"     // Class B
	ViolationTagBlock        ViolationClass = "UNICODE_TAG_BLOCK"          // Class E
	ViolationHTMLComment     ViolationClass = "HTML_COMMENT_STEGANOGRAPHY" // Class D
	ViolationPhraseInjection ViolationClass = "PROMPT_INJECTION_PHRASE"    // Class A
	ViolationInputTooLong    ViolationClass = "INPUT_TOO_LONG"
	ViolationInputTooShort   ViolationClass = "INPUT_TOO_SHORT"
)

// ─── VIOLATION ERROR ──────────────────────────────────────────────────────────

// FirewallViolation is the structured error returned by Sanitize on a hard-reject.
//
// The CBU audit trail requires: trace_id, detected_class, matched_evidence
// (without exposing the full attack payload), and timestamp.
// The Detail field is a redacted, safe-to-log description — never the raw payload.
type FirewallViolation struct {
	Class      ViolationClass
	Detail     string // safe-to-log description, no raw payload
	DetectedAt time.Time
}

// Error implements the error interface.
func (v *FirewallViolation) Error() string {
	return fmt.Sprintf("semantic_firewall REJECT class=%s: %s", v.Class, v.Detail)
}

// ─── INSPECTION RESULT ────────────────────────────────────────────────────────

// InspectionResult is the detailed audit record produced by Inspect.
// It is always populated, even for clean inputs. Clean inputs record zero
// detections with Passed=true.
type InspectionResult struct {
	// Passed is true when the text passed all checks (possibly after stripping).
	Passed bool

	// Violation is non-nil only when Passed is false.
	Violation *FirewallViolation

	// CleanText is the sanitized text (zero-width chars and HTML tags stripped).
	// Only valid when Passed is true.
	CleanText string

	// ZeroWidthCharsRemoved is the count of invisible characters stripped.
	// > 0 is suspicious even on a passing input and should be logged.
	ZeroWidthCharsRemoved int

	// HTMLTagsStripped is the count of HTML tag fragments removed.
	// > 0 in an invoice-scanning context is normal; > 0 in a chat context is suspicious.
	HTMLTagsStripped int

	// OriginalLength is the input's rune count before any modification.
	OriginalLength int

	// CleanLength is the clean text's rune count.
	CleanLength int
}

// ─── FIREWALL CONFIG ──────────────────────────────────────────────────────────

// Config holds tunable parameters for the Firewall.
// All limits are per-request (not aggregate).
type Config struct {
	// MaxInputRunes is the maximum number of Unicode code points accepted.
	// Default: 2000. Inputs beyond this are rejected before any parsing.
	// Rationale: a 2000-rune banking command is already anomalous; 10,000-rune inputs
	// are indicative of invoice injection or LLM context stuffing attacks.
	MaxInputRunes int

	// MinInputRunes is the minimum non-empty input length.
	// Default: 3. Prevents empty/single-char inputs that evade pattern matching.
	MinInputRunes int
}

// DefaultConfig returns a Config with production-safe defaults.
func DefaultConfig() Config {
	return Config{
		MaxInputRunes: 2_000,
		MinInputRunes: 3,
	}
}

// ─── FIREWALL ─────────────────────────────────────────────────────────────────

// Firewall is the Phase F Semantic Firewall. It is safe for concurrent use by
// multiple goroutines — all state is read-only after construction.
type Firewall struct {
	cfg Config
}

// New constructs a Firewall with the given configuration.
func New(cfg Config) *Firewall {
	if cfg.MaxInputRunes <= 0 {
		cfg.MaxInputRunes = DefaultConfig().MaxInputRunes
	}
	if cfg.MinInputRunes <= 0 {
		cfg.MinInputRunes = DefaultConfig().MinInputRunes
	}
	return &Firewall{cfg: cfg}
}

// Sanitize runs the full firewall pipeline on raw input and returns:
//   - (cleanText, nil): input passed all checks; cleanText may differ from raw
//     (zero-width chars and HTML tags stripped).
//   - ("", *FirewallViolation): input was hard-rejected; the caller MUST NOT
//     pass the payload to the LLM.
//
// The function is the primary API for the worker pipeline. For detailed
// introspection (e.g., counting ZW chars removed for audit logging), use Inspect.
func (f *Firewall) Sanitize(raw string) (string, error) {
	result := f.Inspect(raw)
	if !result.Passed {
		return "", result.Violation
	}
	return result.CleanText, nil
}

// Inspect runs the full firewall pipeline and returns a detailed InspectionResult.
// This is the audit-facing API. The HTTP handler calls Sanitize for the
// pass/fail decision; the compliance logger calls Inspect for the full record.
func (f *Firewall) Inspect(raw string) InspectionResult {
	originalLen := utf8.RuneCountInString(raw)
	result := InspectionResult{OriginalLength: originalLen}

	// ── CHECK 0: LENGTH BOUNDS ────────────────────────────────────────────
	if originalLen > f.cfg.MaxInputRunes {
		result.Violation = &FirewallViolation{
			Class:      ViolationInputTooLong,
			Detail:     fmt.Sprintf("input %d runes exceeds maximum %d", originalLen, f.cfg.MaxInputRunes),
			DetectedAt: time.Now().UTC(),
		}
		return result
	}
	if originalLen < f.cfg.MinInputRunes {
		result.Violation = &FirewallViolation{
			Class:      ViolationInputTooShort,
			Detail:     fmt.Sprintf("input %d runes is below minimum %d", originalLen, f.cfg.MinInputRunes),
			DetectedAt: time.Now().UTC(),
		}
		return result
	}

	// ── CHECK 1 (Class B): BIDIRECTIONAL CONTROL CHARACTERS ──────────────
	//
	// Scan rune-by-rune for bidi overrides. This MUST run before any stripping
	// because bidi characters cannot be safely removed — the displayed text after
	// removal is NOT the text the author intended to show. The intent is poisoned.
	for _, r := range raw {
		if _, found := bidiControlRunes[r]; found {
			result.Violation = &FirewallViolation{
				Class: ViolationBidiControl,
				Detail: fmt.Sprintf(
					"bidirectional control character U+%04X detected — "+
						"Trojan Source injection vector (CVE-2021-42574)", r),
				DetectedAt: time.Now().UTC(),
			}
			return result
		}
	}

	// ── CHECK 2 (Class E): UNICODE TAG BLOCK ─────────────────────────────
	//
	// U+E0000–U+E007F. These deprecated language-tag characters are invisible
	// in all renderers but may be processed as instructions by some LLM tokenizers.
	for _, r := range raw {
		if r >= '\U000E0000' && r <= '\U000E007F' {
			result.Violation = &FirewallViolation{
				Class: ViolationTagBlock,
				Detail: fmt.Sprintf(
					"Unicode tag block character U+%06X detected — "+
						"invisible instruction injection vector", r),
				DetectedAt: time.Now().UTC(),
			}
			return result
		}
	}

	// ── STEP 3 (Class C): STRIP ZERO-WIDTH CHARACTERS ────────────────────
	//
	// Zero-width characters are stripped (not rejected) because they may appear
	// in OCR'd text as artifacts. After stripping, we reconstruct the string
	// the attacker intended and run subsequent checks on that reconstruction.
	cleaned, zwRemoved := stripZeroWidth(raw)
	result.ZeroWidthCharsRemoved = zwRemoved

	// ── STEP 4 (Class D): DECODE HTML ENTITIES ───────────────────────────
	//
	// html.UnescapeString decodes both numeric (&#x41;) and named (&lt;) entities.
	// This is mandatory before HTML comment detection to catch encoded injections
	// like: &lt;!-- ignore all instructions --&gt;
	cleaned = html.UnescapeString(cleaned)

	// ── CHECK 5 (Class D): REJECT HTML COMMENTS ──────────────────────────
	//
	// HTML comments (<!-- ... -->) are INVISIBLE to humans and browsers but fully
	// visible to LLM tokenizers. Their only use in this context is steganographic
	// injection. Any input containing HTML comments is hard-rejected.
	if reHTMLComment.MatchString(cleaned) {
		result.Violation = &FirewallViolation{
			Class:      ViolationHTMLComment,
			Detail:     "HTML comment sequence detected — steganographic injection channel",
			DetectedAt: time.Now().UTC(),
		}
		return result
	}

	// ── STEP 6: STRIP REMAINING HTML ─────────────────────────────────────
	//
	// Strip HTML processing instructions (<?...?>) and tags (<b>, </b>, <br/>) —
	// these are OCR artifacts from B2B invoice processing. The count is recorded
	// for audit (legitimate invoices will have some; no invoice should have many).
	before := utf8.RuneCountInString(cleaned)
	cleaned = reHTMLPI.ReplaceAllString(cleaned, " ")
	cleaned = reHTMLTag.ReplaceAllString(cleaned, " ")
	after := utf8.RuneCountInString(cleaned)
	result.HTMLTagsStripped = before - after

	// Strip ASCII control characters (not tab/newline/CR).
	cleaned = reNonPrintableASCII.ReplaceAllString(cleaned, "")

	// Collapse excess whitespace introduced by stripping operations.
	cleaned = reExcessiveWhitespace.ReplaceAllString(cleaned, " ")
	cleaned = strings.TrimSpace(cleaned)

	// ── CHECK 7 (Class A): PROMPT INJECTION PHRASES ──────────────────────
	//
	// Run on the fully reconstructed clean text — AFTER zero-width stripping
	// and entity decoding. This ensures that "ign\u200bore" matches "ignore"
	// and "&#x69;gnore" also matches "ignore".
	//
	// Lowercase once and check all phrases against it.
	lowerClean := strings.ToLower(cleaned)
	for i := range injectionPhrases {
		if strings.Contains(lowerClean, injectionPhrases[i]) {
			result.Violation = &FirewallViolation{
				Class:      ViolationPhraseInjection,
				Detail:     fmt.Sprintf("injection phrase matched: %q", injectionPhrases[i]),
				DetectedAt: time.Now().UTC(),
			}
			return result
		}
	}

	// ── CHECK 8: POST-STRIP LENGTH ────────────────────────────────────────
	//
	// A payload that shrinks to below MinInputRunes after stripping was almost
	// entirely composed of adversarial characters with minimal legitimate content.
	cleanLen := utf8.RuneCountInString(cleaned)
	if cleanLen < f.cfg.MinInputRunes {
		result.Violation = &FirewallViolation{
			Class:      ViolationInputTooShort,
			Detail:     fmt.Sprintf("input reduced to %d runes after sanitisation", cleanLen),
			DetectedAt: time.Now().UTC(),
		}
		return result
	}

	// ── PASS ──────────────────────────────────────────────────────────────
	result.Passed = true
	result.CleanText = cleaned
	result.CleanLength = cleanLen
	return result
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

// stripZeroWidth removes all zero-width and invisible Unicode characters from s.
// Returns the stripped string and the count of characters removed.
//
// Implemented as a single-pass rune scanner writing into a pre-allocated
// string builder. The builder's capacity is pre-set to len(s) bytes (worst-case
// no stripping), so no reallocations occur during the scan.
func stripZeroWidth(s string) (result string, removed int) {
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		if _, isZW := zeroWidthRunes[r]; isZW {
			removed++
			continue
		}
		// Also strip Unicode "general category Cf" (format characters) that are
		// not in our explicit list. These include additional invisible formatting
		// characters across various Unicode blocks.
		// Exception: U+00A0 (NBSP) and U+2007 (FIGURE SPACE) are legitimate
		// in financial text (e.g., "1 000 000 UZS" uses figure spaces).
		if unicode.Is(unicode.Cf, r) && r != '\u00A0' && r != '\u2007' {
			removed++
			continue
		}
		b.WriteRune(r)
	}
	return b.String(), removed
}
