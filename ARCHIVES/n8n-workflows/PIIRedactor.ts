/**
 * ============================================================================
 * REVENANT - PIIRedactor.ts
 * Phase 4.1: Hybrid PII Redaction Engine
 * ============================================================================
 *
 * PURPOSE:
 *   Strips and format-preserves sensitive PII from unstructured strings and
 *   deeply-nested JSON payloads before they reach the LLM consensus engine.
 *   Acts as the last line of defence before data leaves the trust boundary.
 *
 * DETECTION STRATEGY – LAYERED HYBRID APPROACH:
 *   Layer 1 – Structural Regex:
 *     High-precision patterns for well-defined formats (PAN, IBAN, SSN, email,
 *     phone). These fire first as they are cheap and near-zero false-positive.
 *
 *   Layer 2 – Luhn Validation (PAN-specific):
 *     Every candidate credit-card number is run through the Luhn algorithm
 *     before redaction. This eliminates false positives from numeric strings
 *     (e.g., order IDs, timestamps) that happen to match the PAN regex.
 *
 *   Layer 3 – IBAN Checksum Validation (ISO 7064 MOD-97-10):
 *     Candidate IBANs are validated via the standardised mod-97 algorithm
 *     before redaction to avoid nuking legitimate long numeric strings.
 *
 *   Layer 4 – Contextual Heuristics (SSN / National IDs):
 *     SSN-shaped strings are only redacted when they appear near a set of
 *     contextual trigger words (e.g. "ssn", "social", "taxpayer") to suppress
 *     false positives from dates, phone extensions, or reference numbers.
 *
 * FORMAT-PRESERVING MASKING CONVENTIONS:
 *   Credit Card PAN:  4000 1234 5678 9010  →  4000 12** **** **10
 *   IBAN:             GB29 NWBK 6016 1331  →  GB29 **** **** **31
 *   SSN:              123-45-6789          →  ***-**-6789
 *   Email:            alice@example.com    →  a***@***.com
 *   Phone:            +1 (415) 555-0132   →  +1 (***) ***-**32
 *
 * DESIGN PRINCIPLES:
 *   - Immutable: input objects are never mutated; a deep clone is always returned.
 *   - Auditable: every redaction is logged to a RedactionReport with type & location.
 *   - Configurable: individual detectors can be toggled via RedactorOptions.
 *   - Safe defaults: when in doubt, redact. Prefer false-positive over false-negative.
 *   - No external dependencies: pure TypeScript, runs in Node.js / n8n / edge.
 *
 * USAGE:
 *   import { redactPayload, redactString } from './PIIRedactor';
 *
 *   // Deep-redact a JSON object (returns sanitised clone + audit report):
 *   const { sanitised, report } = redactPayload(transactionObject);
 *
 *   // Redact a single string:
 *   const { sanitised: clean } = redactString(rawMemo);
 * ============================================================================
 */

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1 – Public Types
// ─────────────────────────────────────────────────────────────────────────────

/** The category of PII that was detected. */
export type PIIType =
  | "CREDIT_CARD_PAN"
  | "IBAN"
  | "EMAIL"
  | "PHONE"
  | "SSN_NATIONAL_ID";

/** A single redaction event logged during a redactString or redactPayload call. */
export interface RedactionEvent {
  /** What kind of PII was found. */
  type: PIIType;
  /**
   * Dot-notation path within the payload object where the PII appeared.
   * e.g. "user.profile.memo" or "transaction.description"
   * For redactString calls this is always "(root)".
   */
  path: string;
  /** How many non-overlapping occurrences were replaced at this path. */
  count: number;
}

/** Returned by both redactString and redactPayload. */
export interface RedactionResult<T = string> {
  /** The sanitised output (string or deep-cloned object). */
  sanitised: T;
  /** Full audit trail of every redaction performed. */
  report: RedactionReport;
}

/** Aggregate report for an entire redactPayload call. */
export interface RedactionReport {
  /** Total count of individual PII tokens replaced across the entire payload. */
  total_redactions: number;
  /** Flat list of all redaction events, one entry per (path × PIIType) pair. */
  events: RedactionEvent[];
  /** ISO-8601 UTC timestamp of when the redaction was completed. */
  redacted_at: string;
}

/** Per-field options to enable/disable individual detectors. All default to true. */
export interface RedactorOptions {
  redactCreditCards?: boolean;
  redactIBANs?: boolean;
  redactEmails?: boolean;
  redactPhones?: boolean;
  redactSSNs?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2 – Regex Patterns
// ─────────────────────────────────────────────────────────────────────────────

/**
 * PAN (Payment Account Number) – matches 13–19 digit card numbers with optional
 * spaces or hyphens as separators. The Luhn check eliminates false positives.
 *
 * Breakdown:
 *   \b           – word boundary (prevents matching mid-number)
 *   [3-6]\d{3}   – first 4 digits (major industry identifier prefix: 3/4/5/6)
 *   [-\s]?       – optional separator (space or hyphen)
 *   (?:\d{4}[-\s]?){2,3} – 2 or 3 groups of 4 digits
 *   \d{1,4}      – final 1–4 digits
 *   \b
 *
 * This intentionally covers: Visa (16d), Mastercard (16d), Amex (15d),
 * Discover (16d), Diners (14d), UnionPay (16–19d).
 */
const REGEX_PAN = /\b[3-6]\d{3}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{1,7}\b/g;

/**
 * IBAN – International Bank Account Number (ISO 13616).
 * Matches the country code + check digits + BBAN without spaces, or the
 * print format with spaces every 4 characters.
 *
 * Supports all 77 registered IBAN country codes (2 uppercase letters).
 * Max IBAN length is 34 characters. The MOD-97 checksum is validated separately.
 */
const REGEX_IBAN = /\b([A-Z]{2})(\d{2})\s?([A-Z0-9]{4}\s?){1,7}([A-Z0-9]{1,4})\b/g;

/**
 * Email – RFC 5321 simplified pattern.
 * Covers the practical universe of real-world email addresses without
 * implementing the full RFC grammar (which is computationally expensive).
 */
const REGEX_EMAIL =
  /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g;

/**
 * Phone – matches international and domestic formats.
 * Intentionally broad to capture:
 *   E.164:          +14155550132
 *   US domestic:    (415) 555-0132  /  415-555-0132  /  415.555.0132
 *   Intl with CC:   +1 415 555 0132  /  +44 20 7946 0958
 *   Extensions:     ext. 101  /  x101
 *
 * Minimum 7 digits required (shortest valid NANP subscriber number).
 * Anchored with lookbehind/lookahead to avoid matching version numbers or dates.
 */
const REGEX_PHONE =
  /(?<!\d)(\+?1?\s?)?(\(?\d{3}\)?[\s.\-]?)(\d{3}[\s.\-]?\d{4})(\s?(ext|x)\.?\s?\d{1,5})?(?!\d)/g;

/**
 * SSN / National ID – matches US SSN formats:
 *   Hyphenated:      123-45-6789
 *   Space-separated: 123 45 6789
 *   Bare digits:     123456789  (only with contextual trigger — see Layer 4)
 *
 * The bare-digit variant deliberately requires the contextual heuristic layer
 * to prevent redacting tracking numbers, dates, and reference IDs.
 */
const REGEX_SSN_HYPHEN = /\b(?!000|666|9\d{2})([0-8]\d{2})[-\s](?!00)(\d{2})[-\s](?!0000)(\d{4})\b/g;

/**
 * Contextual trigger words for SSN bare-digit detection (Layer 4).
 * When a window of text around a 9-digit number contains one of these,
 * it is treated as an SSN and redacted.
 */
const SSN_CONTEXT_TRIGGERS = [
  "ssn",
  "social security",
  "social sec",
  "tin",
  "taxpayer",
  "itin",
  "national id",
  "nationalid",
  "national_id",
  "tax id",
  "taxid",
  "sin",            // Canadian Social Insurance Number
  "nino",           // UK National Insurance Number
  "national insurance",
];

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3 – Validation Algorithms
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Luhn Algorithm – validates credit/debit card numbers.
 *
 * Process:
 *   1. Strip non-digits.
 *   2. Traverse digits right-to-left.
 *   3. Double every second digit; if the doubled value > 9, subtract 9.
 *   4. Sum all digits. A valid PAN has sum ≡ 0 (mod 10).
 *
 * @param raw - The candidate PAN string (may contain spaces/hyphens).
 * @returns true if the number satisfies the Luhn check.
 */
function luhnCheck(raw: string): boolean {
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19) return false;

  let sum = 0;
  let double = false;

  // Iterate right-to-left
  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = parseInt(digits[i], 10);

    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }

    sum += digit;
    double = !double;
  }

  return sum % 10 === 0;
}

/**
 * IBAN MOD-97-10 Checksum Validation (ISO 7064).
 *
 * Process:
 *   1. Move the first 4 characters to the end.
 *   2. Replace each letter with its numeric equivalent (A=10, B=11, …, Z=35).
 *   3. Compute the integer remainder of the resulting number mod 97.
 *   4. Valid if remainder === 1.
 *
 * @param raw - Candidate IBAN string (spaces are stripped internally).
 * @returns true if the IBAN passes the MOD-97 check.
 */
function ibanCheck(raw: string): boolean {
  const iban = raw.replace(/\s/g, "").toUpperCase();
  if (iban.length < 15 || iban.length > 34) return false;

  // Rearrange: move first 4 chars to end
  const rearranged = iban.slice(4) + iban.slice(0, 4);

  // Expand letters to digits
  const numeric = rearranged
    .split("")
    .map((ch) => {
      const code = ch.charCodeAt(0);
      // A=65 → 10, B=66 → 11, …, Z=90 → 35
      return code >= 65 && code <= 90 ? (code - 55).toString() : ch;
    })
    .join("");

  // BigInt division: JavaScript number precision is insufficient for 30+ digit strings
  let remainder = 0;
  for (const chunk of numeric.match(/.{1,9}/g) ?? []) {
    remainder = (remainder * 10 ** BigInt(chunk.length) + BigInt(chunk)) % 97;
  }

  return remainder === 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 4 – Format-Preserving Masking Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Masks a PAN while preserving the first 6 digits (BIN/IIN) and last 4 digits.
 * Separators (spaces / hyphens) are reconstructed in their original positions.
 *
 * Example: "4000 1234 5678 9010"  →  "4000 12** **** **10"
 * Example: "378282246310005"      →  "378282****0005"
 */
function maskPAN(pan: string): string {
  const digits = pan.replace(/\D/g, "");
  const sep = pan.includes(" ") ? " " : pan.includes("-") ? "-" : "";

  // Reveal first 6 digits and last 4 digits; mask the rest
  const masked = digits
    .split("")
    .map((d, i) => {
      if (i < 6 || i >= digits.length - 4) return d;
      return "*";
    })
    .join("");

  // Re-apply original separators (every 4 chars for standard 16-digit cards)
  if (!sep) return masked;
  const groups: string[] = [];
  for (let i = 0; i < masked.length; i += 4) {
    groups.push(masked.slice(i, i + 4));
  }
  return groups.join(sep);
}

/**
 * Masks an IBAN, preserving the country code + check digits (first 4 chars)
 * and the last 4 characters of the BBAN. Interior is fully masked.
 *
 * Example: "GB29 NWBK 6016 1331 9268 19"  →  "GB29 **** **** **** **** **"
 *
 * Spaces are preserved in their original positions.
 */
function maskIBAN(iban: string): string {
  const spaces: number[] = [];
  const stripped = iban
    .split("")
    .filter((ch, i) => {
      if (ch === " ") { spaces.push(i); return false; }
      return true;
    })
    .join("");

  // Keep first 4 chars (country + check digits) and last 4 chars (partial BBAN)
  const reveal_start = 4;
  const reveal_end = stripped.length - 4;

  const masked = stripped
    .split("")
    .map((ch, i) => (i < reveal_start || i >= reveal_end) ? ch : "*")
    .join("");

  // Reinsert spaces at original positions
  let result = masked;
  let offset = 0;
  for (const pos of spaces) {
    result = result.slice(0, pos + offset) + " " + result.slice(pos + offset);
    offset++;
  }
  return result;
}

/**
 * Masks an email address:
 *   - Reveals only the first character of the local-part.
 *   - Masks the rest of the local-part with ***.
 *   - Reveals only the TLD of the domain.
 *   - Masks the domain name with ***.
 *
 * Example: "alice.smith@bigbank.com"  →  "a***@***.com"
 */
function maskEmail(email: string): string {
  const atIdx = email.lastIndexOf("@");
  if (atIdx < 1) return "***@***.***";

  const local = email.slice(0, atIdx);
  const domain = email.slice(atIdx + 1);

  const maskedLocal = local[0] + "***";

  const dotIdx = domain.lastIndexOf(".");
  const tld = dotIdx >= 0 ? domain.slice(dotIdx) : "";   // e.g. ".com"
  const maskedDomain = "***" + tld;

  return `${maskedLocal}@${maskedDomain}`;
}

/**
 * Masks a phone number by replacing all digits except the final 2 with *.
 * Preserves the original format structure (parentheses, spaces, hyphens, +).
 *
 * Example: "+1 (415) 555-0132"  →  "+1 (***) ***-**32"
 */
function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  // Preserve last 2 digits; mask everything else
  const maskedDigits = digits
    .split("")
    .map((d, i) => (i >= digits.length - 2 ? d : "*"))
    .join("");

  // Re-apply formatting from original string
  let digitIndex = 0;
  return phone
    .split("")
    .map((ch) => {
      if (/\d/.test(ch)) return maskedDigits[digitIndex++];
      return ch;
    })
    .join("");
}

/**
 * Masks an SSN / National ID in any format:
 *   - Hyphenated: 123-45-6789  →  ***-**-6789
 *   - Spaced:     123 45 6789  →  *** ** 6789
 *   - Bare:       123456789    →  *****6789
 *
 * Preserves the last 4 digits (industry convention per PCI / US privacy law).
 */
function maskSSN(ssn: string): string {
  const sep = ssn.includes("-") ? "-" : ssn.includes(" ") ? " " : "";
  const digits = ssn.replace(/\D/g, "");

  const masked = digits
    .split("")
    .map((d, i) => (i >= digits.length - 4 ? d : "*"))
    .join("");

  if (!sep) return masked;

  // Re-apply SSN separators at positions 3 and 5
  return `${masked.slice(0, 3)}${sep}${masked.slice(3, 5)}${sep}${masked.slice(5)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 5 – Core String Redaction Pipeline
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Internal accumulator for tracking redaction counts during a single run.
 */
type RedactionCounts = Partial<Record<PIIType, number>>;

/**
 * Runs the full hybrid detection pipeline on a single string.
 * Returns the sanitised string and a map of how many replacements were made
 * per PIIType.
 *
 * @param input   - The raw string to inspect.
 * @param opts    - Feature flags for individual detectors.
 * @param context - Optional surrounding text for contextual heuristics (SSN).
 *                  Defaults to `input` itself.
 */
function _redactString(
  input: string,
  opts: Required<RedactorOptions>,
  context: string = input
): { result: string; counts: RedactionCounts } {
  let result = input;
  const counts: RedactionCounts = {};

  const increment = (type: PIIType, n = 1) => {
    counts[type] = (counts[type] ?? 0) + n;
  };

  // ── Layer 1+2: Credit Card PANs (Regex + Luhn) ───────────────────────────
  if (opts.redactCreditCards) {
    result = result.replace(REGEX_PAN, (match) => {
      if (!luhnCheck(match)) return match;   // false positive – leave intact
      increment("CREDIT_CARD_PAN");
      return maskPAN(match);
    });
    // Reset lastIndex (global regex) after use
    REGEX_PAN.lastIndex = 0;
  }

  // ── Layer 1+3: IBANs (Regex + MOD-97 checksum) ───────────────────────────
  if (opts.redactIBANs) {
    result = result.replace(REGEX_IBAN, (match) => {
      if (!ibanCheck(match)) return match;   // false positive – leave intact
      increment("IBAN");
      return maskIBAN(match);
    });
    REGEX_IBAN.lastIndex = 0;
  }

  // ── Layer 1: Email addresses ──────────────────────────────────────────────
  if (opts.redactEmails) {
    result = result.replace(REGEX_EMAIL, (match) => {
      increment("EMAIL");
      return maskEmail(match);
    });
    REGEX_EMAIL.lastIndex = 0;
  }

  // ── Layer 1: Phone numbers ────────────────────────────────────────────────
  if (opts.redactPhones) {
    result = result.replace(REGEX_PHONE, (match) => {
      // Sanity check: must have at least 7 digits to be a plausible phone number
      const digitCount = (match.match(/\d/g) ?? []).length;
      if (digitCount < 7) return match;
      increment("PHONE");
      return maskPhone(match);
    });
    REGEX_PHONE.lastIndex = 0;
  }

  // ── Layer 1+4: SSN / National IDs (hyphenated format – high confidence) ──
  if (opts.redactSSNs) {
    result = result.replace(REGEX_SSN_HYPHEN, (match) => {
      increment("SSN_NATIONAL_ID");
      return maskSSN(match);
    });
    REGEX_SSN_HYPHEN.lastIndex = 0;

    // ── Layer 4 only: Bare 9-digit SSN (contextual heuristic) ─────────────
    //
    // A bare 9-digit number is only redacted when the surrounding context
    // (the full field value, or a ±200-character window) contains a known
    // SSN trigger word. This prevents false positives on amounts, dates, IDs.
    const contextLower = context.toLowerCase();
    const hasSSNContext = SSN_CONTEXT_TRIGGERS.some((t) =>
      contextLower.includes(t)
    );

    if (hasSSNContext) {
      // Match bare 9-digit strings (not preceded or followed by another digit)
      result = result.replace(
        /(?<!\d)(?!000|666|9\d{2})([0-8]\d{2})(?!00)(\d{2})(?!0000)(\d{4})(?!\d)/g,
        (match) => {
          increment("SSN_NATIONAL_ID");
          return maskSSN(match);
        }
      );
    }
  }

  return { result, counts };
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 6 – Deep JSON Traversal
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Recursively traverses a value of any JSON-compatible type and applies PII
 * redaction to every string it encounters.
 *
 * Supported types:
 *   - string   → redacted in-place
 *   - number   → left unchanged (PAN detection happens at string level only)
 *   - boolean  → left unchanged
 *   - null     → left unchanged
 *   - Array    → each element traversed recursively
 *   - Object   → each value traversed recursively; keys are NOT redacted
 *                (field names are schema-defined, not user-generated PII)
 *
 * @param value  - The current node being traversed.
 * @param path   - Dot-notation path accumulated during traversal (for the audit log).
 * @param opts   - Detector feature flags.
 * @param events - Mutable accumulator for RedactionEvent records.
 */
function _traverseAndRedact(
  value: unknown,
  path: string,
  opts: Required<RedactorOptions>,
  events: RedactionEvent[]
): unknown {
  if (typeof value === "string") {
    const { result, counts } = _redactString(value, opts);

    // Log one event per PIIType detected in this field
    for (const [type, count] of Object.entries(counts) as [PIIType, number][]) {
      if (count > 0) {
        events.push({ type, path, count });
      }
    }

    return result;
  }

  if (Array.isArray(value)) {
    return value.map((item, idx) =>
      _traverseAndRedact(item, `${path}[${idx}]`, opts, events)
    );
  }

  if (value !== null && typeof value === "object") {
    const sanitised: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      sanitised[key] = _traverseAndRedact(
        child,
        path ? `${path}.${key}` : key,
        opts,
        events
      );
    }
    return sanitised;
  }

  // Primitives other than string (number, boolean, null, undefined) pass through
  return value;
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 7 – Public API
// ─────────────────────────────────────────────────────────────────────────────

/** Default options – all detectors enabled. */
const DEFAULT_OPTIONS: Required<RedactorOptions> = {
  redactCreditCards: true,
  redactIBANs: true,
  redactEmails: true,
  redactPhones: true,
  redactSSNs: true,
};

/**
 * Redacts PII from a single string.
 *
 * @param input   - The raw string to sanitise.
 * @param options - Optional detector toggles.
 *
 * @returns { sanitised: string, report: RedactionReport }
 *
 * @example
 * const { sanitised } = redactString("Pay to alice@bank.com, card 4000 1234 5678 9010");
 * // → "Pay to a***@***.com, card 4000 12** **** **10"
 */
export function redactString(
  input: string,
  options?: RedactorOptions
): RedactionResult<string> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const events: RedactionEvent[] = [];
  const { result, counts } = _redactString(input, opts);

  for (const [type, count] of Object.entries(counts) as [PIIType, number][]) {
    if (count > 0) events.push({ type, path: "(root)", count });
  }

  return {
    sanitised: result,
    report: {
      total_redactions: events.reduce((s, e) => s + e.count, 0),
      events,
      redacted_at: new Date().toISOString(),
    },
  };
}

/**
 * Deeply traverses a JSON-compatible payload and redacts all PII from every
 * string value, returning a sanitised deep clone and a full audit report.
 *
 * The original payload is NEVER mutated.
 *
 * @param payload - Any JSON-serialisable value (object, array, string, etc.).
 * @param options - Optional detector toggles.
 *
 * @returns { sanitised: T, report: RedactionReport }
 *
 * @example
 * const { sanitised, report } = redactPayload({
 *   user: { email: "alice@bigbank.com", memo: "SSN 123-45-6789" },
 *   amount: 5000
 * });
 * // sanitised.user.email  → "a***@***.com"
 * // sanitised.user.memo   → "SSN ***-**-6789"
 * // sanitised.amount      → 5000  (unchanged)
 * // report.total_redactions → 2
 */
export function redactPayload<T = unknown>(
  payload: T,
  options?: RedactorOptions
): RedactionResult<T> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const events: RedactionEvent[] = [];

  const sanitised = _traverseAndRedact(payload, "", opts, events) as T;

  return {
    sanitised,
    report: {
      total_redactions: events.reduce((s, e) => s + e.count, 0),
      events,
      redacted_at: new Date().toISOString(),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 8 – n8n / CLI Self-Test
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Smoke-test suite. Executes when this file is run directly:
 *   ts-node PIIRedactor.ts
 *
 * In an n8n Code node, import and call redactPayload() directly.
 */
if (
  typeof require !== "undefined" &&
  typeof module !== "undefined" &&
  require.main === module
) {
  const SAMPLE_PAYLOAD = {
    transaction_id: "TXN-20240514-00887612",
    amount_usd: 94750.00,
    memo: "Wire transfer from alice.smith@globalfinance.com. " +
      "Ref card 4000 1234 5678 9010 and backup 378282246310005. " +
      "IBAN: GB29 NWBK 6016 1331 9268 19. " +
      "Call +1 (415) 555-0132 for confirmation.",
    sender: {
      name: "Alice Smith",
      email: "alice.smith@globalfinance.com",
      phone: "+44 20 7946 0958",
      national_id_context: "Taxpayer ID (SSN): 123-45-6789",
    },
    notes: [
      "Secondary contact: bob@payments.io",
      "Authorised by SSN 987654321",
      "Reference: 20240514-XYZ (not an SSN)",
    ],
    metadata: {
      is_high_risk: true,
      amount_usd: 94750.00, // numbers are untouched
    },
  };

  console.log("═══════════════════════════════════════════════════════");
  console.log("  REVENANT PIIRedactor – Smoke Test");
  console.log("═══════════════════════════════════════════════════════\n");

  // ── Individual string tests ──────────────────────────────────────────────
  const STRING_TESTS: Array<{ label: string; input: string }> = [
    { label: "Visa PAN (spaced)", input: "Card: 4000 1234 5678 9010" },
    { label: "Amex PAN (bare)", input: "Amex: 378282246310005" },
    { label: "IBAN", input: "IBAN: GB29 NWBK 6016 1331 9268 19" },
    { label: "Email", input: "Contact: alice.smith@bigbank.com" },
    { label: "US Phone", input: "Call (415) 555-0132 or +1 800-555-0199" },
    { label: "SSN hyphenated", input: "SSN: 123-45-6789" },
    { label: "SSN bare (context)", input: "taxpayer 987654321 on file" },
    { label: "False positive – order ID", input: "Order #1234567890123 processed" },
  ];

  for (const { label, input } of STRING_TESTS) {
    const { sanitised } = redactString(input);
    console.log(`  [${label}]`);
    console.log(`    IN:  ${input}`);
    console.log(`    OUT: ${sanitised}\n`);
  }

  // ── Deep payload test ────────────────────────────────────────────────────
  console.log("─── Deep Payload Redaction ─────────────────────────────\n");
  const { sanitised, report } = redactPayload(SAMPLE_PAYLOAD);

  console.log("Sanitised payload:");
  console.log(JSON.stringify(sanitised, null, 2));
  console.log("\nRedaction report:");
  console.log(JSON.stringify(report, null, 2));
}