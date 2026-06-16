/**
 * ============================================================================
 * REVENANT - ConsensusEngine.ts
 * Phase 3: SLA-Enforced Cognitive Engine
 * ============================================================================
 *
 * PURPOSE:
 *   Enforces Multi-Provider Consensus Routing for high-risk transactions.
 *   Both OpenAI (gpt-4o) and Anthropic (claude-3-5-sonnet-20241022) must
 *   independently APPROVE a transaction for it to pass. Any disagreement,
 *   timeout, or error immediately escalates to a human operator.
 *
 * DESIGN PRINCIPLES:
 *   - Fail-Closed: Every error path returns ESCALATE_TO_HUMAN, never APPROVED.
 *   - Parallel Execution: Both providers are called simultaneously to minimise
 *     total latency. Total wall-clock time ≈ max(provider_a, provider_b).
 *   - SLA-Gated: Hard AbortController timeout per provider (default 6 000 ms).
 *   - Deterministic Hashing: Canonical JSON of both raw responses is SHA-256
 *     hashed for WORM audit trail integrity verification.
 *   - Zero external dependencies: uses only the native fetch API and the
 *     Node.js built-in `crypto` module so it runs in Node.js, n8n Code nodes,
 *     and any V8-based edge runtime without additional packages.
 *
 * ENVIRONMENT VARIABLES REQUIRED:
 *   OPENAI_API_KEY      – OpenAI secret key
 *   ANTHROPIC_API_KEY   – Anthropic secret key
 *
 * USAGE (Node.js / n8n Code node):
 *   import { runConsensus } from './ConsensusEngine';
 *
 *   const result = await runConsensus(transactionPayload, riskPrompt);
 *   // result.consensus === 'APPROVED' | 'ESCALATE_TO_HUMAN'
 * ============================================================================
 */

import { createHash } from "crypto";

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1 – Type Definitions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The canonical JSON schema both AI providers MUST return.
 * Any response that does not conform is treated as a provider failure.
 */
export interface AIProviderResponse {
  /** Binary risk decision for the transaction. */
  action: "APPROVE" | "DENY";
  /** Model's self-reported confidence in the decision (0.0 – 1.0). */
  confidence: number;
  /** List of compliance/risk rule identifiers triggered during analysis. */
  rules_triggered: string[];
}

/**
 * Internal result wrapper for a single provider call.
 * Carries both the parsed decision and the raw envelope for the audit trail.
 */
interface ProviderResult {
  /** Parsed, schema-validated response. */
  parsed: AIProviderResponse;
  /** Wall-clock round-trip time for this provider call (ms). */
  latency_ms: number;
  /**
   * Provider-native correlation identifier.
   * OpenAI:    response.system_fingerprint
   * Anthropic: response.id  (e.g. "msg_01XFDUDYJgAACzvnptvVoYEL")
   */
  provider_id: string;
  /** Raw JSON envelope returned by the provider (stored verbatim for WORM). */
  raw_envelope: unknown;
}

/**
 * The final output of the consensus engine, safe to persist to your audit log.
 */
export interface ConsensusResult {
  /**
   * APPROVED            – Both providers independently approved the transaction.
   * ESCALATE_TO_HUMAN   – Disagreement, timeout, schema violation, or any error.
   */
  consensus: "APPROVED" | "ESCALATE_TO_HUMAN";

  /** ISO-8601 UTC timestamp of when the consensus decision was reached. */
  decided_at: string;

  /** SHA-256 hex digest of the canonical audit payload (for WORM integrity). */
  audit_hash: string;

  openai: {
    action: AIProviderResponse["action"] | "FAILED";
    confidence: number | null;
    rules_triggered: string[] | null;
    latency_ms: number;
    provider_id: string | null;
  };

  anthropic: {
    action: AIProviderResponse["action"] | "FAILED";
    confidence: number | null;
    rules_triggered: string[] | null;
    latency_ms: number;
    provider_id: string | null;
  };

  /**
   * Human-readable explanation of why this consensus was reached.
   * Useful for audit log readability and human-review queue context.
   */
  reason: string;
}

/** Raw top-level envelope from the OpenAI Chat Completions API. */
interface OpenAIEnvelope {
  id: string;
  system_fingerprint?: string;
  choices: Array<{
    message: {
      content: string | null;
    };
  }>;
}

/** Raw top-level envelope from the Anthropic Messages API. */
interface AnthropicEnvelope {
  id: string;
  content: Array<{
    type: string;
    text?: string;
  }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2 – Configuration
// ─────────────────────────────────────────────────────────────────────────────

const CONFIG = {
  /** Hard SLA per provider call (ms). Exceeding this → provider FAILED. */
  SLA_TIMEOUT_MS: 6_000,

  /** OpenAI model identifier. */
  OPENAI_MODEL: "gpt-4o" as const,

  /** Anthropic model identifier. */
  ANTHROPIC_MODEL: "claude-3-5-sonnet-20241022" as const,

  /**
   * OpenAI seed for deterministic sampling.
   * Note: OpenAI does not guarantee identical outputs even with a fixed seed,
   * but it improves reproducibility for audit/replay purposes.
   */
  OPENAI_SEED: 42,

  /**
   * Temperature for both providers.
   * 0 = maximally deterministic / greedy decoding.
   */
  TEMPERATURE: 0,

  /** Maximum tokens to generate from each provider. */
  MAX_TOKENS: 512,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3 – JSON Schema Prompt Fragment
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Injected into every provider call as a system instruction.
 * Forces structured output in our canonical schema.
 */
const SCHEMA_ENFORCEMENT_PROMPT = `
You are a financial risk evaluation engine operating under strict regulatory oversight.

CRITICAL INSTRUCTIONS:
1. Analyse the provided transaction payload and risk prompt.
2. You MUST respond with ONLY a single, valid JSON object. No markdown, no prose, no explanation.
3. The JSON object MUST conform exactly to this schema:
   {
     "action":          "APPROVE" | "DENY",       // Your binary risk decision
     "confidence":      <number between 0.0 and 1.0>, // Your confidence level
     "rules_triggered": [<string>, ...]            // List of rule IDs or empty array
   }

Example rule IDs: "AML-001", "VELOCITY-HIGH", "GEO-MISMATCH", "THRESHOLD-EXCEED"

If you cannot make a determination, respond with:
  { "action": "DENY", "confidence": 1.0, "rules_triggered": ["INDETERMINATE"] }

Do NOT include any text outside the JSON object.
`.trim();

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 4 – Helper Utilities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates an AbortSignal that fires after `ms` milliseconds.
 * Compatible with Node.js ≥ 18 and all modern edge runtimes.
 */
function createTimeoutSignal(ms: number): AbortSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);

  // Prevent the timer from blocking process exit in Node.js
  if (typeof timer === "object" && "unref" in timer) {
    (timer as NodeJS.Timeout).unref();
  }

  return controller.signal;
}

/**
 * Parse and validate a raw provider response string against our AIProviderResponse schema.
 * Returns null if the string is not valid JSON or does not match the schema.
 *
 * @param raw - The string content from the provider's message body.
 */
function parseAndValidate(raw: string | null | undefined): AIProviderResponse | null {
  if (!raw) return null;

  let parsed: unknown;
  try {
    // Strip any accidental markdown fences (e.g. ```json ... ```) before parsing
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
    parsed = JSON.parse(cleaned);
  } catch {
    return null;
  }

  // Type-guard: verify the shape matches our schema
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("action" in parsed) ||
    !("confidence" in parsed) ||
    !("rules_triggered" in parsed)
  ) {
    return null;
  }

  const obj = parsed as Record<string, unknown>;

  if (obj.action !== "APPROVE" && obj.action !== "DENY") return null;
  if (typeof obj.confidence !== "number") return null;
  if (!Array.isArray(obj.rules_triggered)) return null;
  if (!obj.rules_triggered.every((r) => typeof r === "string")) return null;

  return {
    action: obj.action,
    confidence: Math.min(1, Math.max(0, obj.confidence)), // clamp to [0, 1]
    rules_triggered: obj.rules_triggered,
  };
}

/**
 * Compute a SHA-256 hex digest over a deterministic JSON representation
 * of the provided object. Used to produce the WORM audit trail hash.
 *
 * The input is serialised with sorted keys to ensure canonical ordering
 * regardless of insertion order in the calling code.
 */
function sha256Hex(data: unknown): string {
  // JSON.stringify with a replacer that sorts keys for canonical form
  const canonical = JSON.stringify(data, Object.keys(data as object).sort());
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 5 – Provider Call: OpenAI
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calls the OpenAI Chat Completions endpoint with gpt-4o.
 * Returns a fully-typed ProviderResult or throws on any failure
 * (network error, non-2xx HTTP status, schema mismatch, or SLA breach).
 *
 * @param transactionPayload - Serialised transaction object to analyse.
 * @param riskPrompt         - Caller-supplied risk-analysis prompt.
 * @param apiKey             - OpenAI API secret key.
 */
async function callOpenAI(
  transactionPayload: string,
  riskPrompt: string,
  apiKey: string
): Promise<ProviderResult> {
  const startedAt = Date.now();

  const requestBody = {
    model: CONFIG.OPENAI_MODEL,
    seed: CONFIG.OPENAI_SEED,
    temperature: CONFIG.TEMPERATURE,
    max_tokens: CONFIG.MAX_TOKENS,
    // Ask the API to return JSON via response_format (gpt-4o supports this)
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: SCHEMA_ENFORCEMENT_PROMPT,
      },
      {
        role: "user",
        content: `RISK PROMPT:\n${riskPrompt}\n\nTRANSACTION PAYLOAD:\n${transactionPayload}`,
      },
    ],
  };

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(requestBody),
    // SLA enforcement: abort the fetch if it exceeds the hard limit
    signal: createTimeoutSignal(CONFIG.SLA_TIMEOUT_MS),
  });

  const latency_ms = Date.now() - startedAt;

  if (!response.ok) {
    const errorText = await response.text().catch(() => "<unreadable>");
    throw new Error(
      `OpenAI HTTP ${response.status}: ${errorText.slice(0, 200)}`
    );
  }

  const envelope = (await response.json()) as OpenAIEnvelope;

  // Extract the text content from the first choice
  const rawContent = envelope?.choices?.[0]?.message?.content;

  const parsed = parseAndValidate(rawContent);
  if (!parsed) {
    throw new Error(
      `OpenAI response failed schema validation. Raw content: ${String(rawContent).slice(0, 300)}`
    );
  }

  return {
    parsed,
    latency_ms,
    // Prefer system_fingerprint for determinism tracking; fall back to response ID
    provider_id: envelope.system_fingerprint ?? envelope.id,
    raw_envelope: envelope,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 6 – Provider Call: Anthropic
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calls the Anthropic Messages endpoint with claude-3-5-sonnet-20241022.
 * Returns a fully-typed ProviderResult or throws on any failure
 * (network error, non-2xx HTTP status, schema mismatch, or SLA breach).
 *
 * @param transactionPayload - Serialised transaction object to analyse.
 * @param riskPrompt         - Caller-supplied risk-analysis prompt.
 * @param apiKey             - Anthropic API secret key.
 */
async function callAnthropic(
  transactionPayload: string,
  riskPrompt: string,
  apiKey: string
): Promise<ProviderResult> {
  const startedAt = Date.now();

  const requestBody = {
    model: CONFIG.ANTHROPIC_MODEL,
    max_tokens: CONFIG.MAX_TOKENS,
    temperature: CONFIG.TEMPERATURE,
    system: SCHEMA_ENFORCEMENT_PROMPT,
    messages: [
      {
        role: "user",
        content: `RISK PROMPT:\n${riskPrompt}\n\nTRANSACTION PAYLOAD:\n${transactionPayload}`,
      },
    ],
  };

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      // Required header for the Anthropic Messages API
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(requestBody),
    signal: createTimeoutSignal(CONFIG.SLA_TIMEOUT_MS),
  });

  const latency_ms = Date.now() - startedAt;

  if (!response.ok) {
    const errorText = await response.text().catch(() => "<unreadable>");
    throw new Error(
      `Anthropic HTTP ${response.status}: ${errorText.slice(0, 200)}`
    );
  }

  const envelope = (await response.json()) as AnthropicEnvelope;

  // Anthropic returns content as an array of typed blocks; find the first text block
  const textBlock = envelope?.content?.find((b) => b.type === "text");
  const rawContent = textBlock?.text;

  const parsed = parseAndValidate(rawContent);
  if (!parsed) {
    throw new Error(
      `Anthropic response failed schema validation. Raw content: ${String(rawContent).slice(0, 300)}`
    );
  }

  return {
    parsed,
    latency_ms,
    // Anthropic uses a message ID as the primary correlation handle
    provider_id: envelope.id,
    raw_envelope: envelope,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 7 – Consensus Engine Entry Point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Executes parallel AI consensus evaluation for a high-risk transaction.
 *
 * Both providers are called simultaneously using Promise.allSettled so that
 * neither provider's failure short-circuits the other's call. The results are
 * then evaluated under strict consensus rules.
 *
 * CONSENSUS RULES (fail-closed):
 *   APPROVED            ← openai.action === 'APPROVE' AND anthropic.action === 'APPROVE'
 *   ESCALATE_TO_HUMAN   ← any other combination (disagreement, error, timeout)
 *
 * @param transaction   - The transaction object to evaluate. Will be JSON-serialised.
 * @param prompt        - The risk-analysis prompt describing evaluation criteria.
 * @param options       - Optional overrides (API keys, SLA timeout).
 *
 * @returns ConsensusResult – always resolves (never rejects), defaults to ESCALATE_TO_HUMAN.
 */
export async function runConsensus(
  transaction: Record<string, unknown>,
  prompt: string,
  options?: {
    openaiApiKey?: string;
    anthropicApiKey?: string;
  }
): Promise<ConsensusResult> {
  // ── Resolve API keys (env vars as fallback for n8n Code node compatibility) ──
  const openaiKey =
    options?.openaiApiKey ??
    (typeof process !== "undefined" ? process.env.OPENAI_API_KEY : undefined) ??
    "";

  const anthropicKey =
    options?.anthropicApiKey ??
    (typeof process !== "undefined" ? process.env.ANTHROPIC_API_KEY : undefined) ??
    "";

  // Fail-closed immediately if keys are missing — don't waste quota or latency
  if (!openaiKey || !anthropicKey) {
    const decided_at = new Date().toISOString();
    const result: ConsensusResult = {
      consensus: "ESCALATE_TO_HUMAN",
      decided_at,
      audit_hash: "",
      openai: { action: "FAILED", confidence: null, rules_triggered: null, latency_ms: 0, provider_id: null },
      anthropic: { action: "FAILED", confidence: null, rules_triggered: null, latency_ms: 0, provider_id: null },
      reason: "ESCALATED: One or both API keys are missing. Cannot execute consensus evaluation.",
    };
    result.audit_hash = sha256Hex({ ...result, audit_hash: undefined });
    return result;
  }

  // Serialise the transaction payload once — both providers receive identical input
  const transactionPayload = JSON.stringify(transaction, null, 2);

  // ── Execute both provider calls in parallel ──────────────────────────────────
  //
  // Promise.allSettled ensures we always get both outcomes regardless of which
  // provider fails or succeeds first. This prevents a single provider timeout
  // from silently cancelling the peer call.
  const [openaiSettled, anthropicSettled] = await Promise.allSettled([
    callOpenAI(transactionPayload, prompt, openaiKey),
    callAnthropic(transactionPayload, prompt, anthropicKey),
  ]);

  // ── Extract results or failure metadata from each settled promise ────────────
  const openaiOk = openaiSettled.status === "fulfilled";
  const anthropicOk = anthropicSettled.status === "fulfilled";

  const oaiResult = openaiOk ? openaiSettled.value : null;
  const antResult = anthropicOk ? anthropicSettled.value : null;

  // Log provider-level failures for observability (n8n surfaces console output)
  if (!openaiOk) {
    console.error("[ConsensusEngine] OpenAI provider FAILED:", openaiSettled.reason);
  }
  if (!anthropicOk) {
    console.error("[ConsensusEngine] Anthropic provider FAILED:", anthropicSettled.reason);
  }

  // ── Apply consensus rules ────────────────────────────────────────────────────
  const bothSucceeded = openaiOk && anthropicOk;
  const bothApprove =
    bothSucceeded &&
    oaiResult!.parsed.action === "APPROVE" &&
    antResult!.parsed.action === "APPROVE";

  let consensus: "APPROVED" | "ESCALATE_TO_HUMAN";
  let reason: string;

  if (bothApprove) {
    consensus = "APPROVED";
    reason =
      `Both providers independently approved the transaction. ` +
      `OpenAI confidence: ${oaiResult!.parsed.confidence.toFixed(3)}, ` +
      `Anthropic confidence: ${antResult!.parsed.confidence.toFixed(3)}.`;
  } else if (!openaiOk && !anthropicOk) {
    consensus = "ESCALATE_TO_HUMAN";
    reason = "ESCALATED: Both providers failed or timed out. No consensus possible.";
  } else if (!openaiOk) {
    consensus = "ESCALATE_TO_HUMAN";
    reason = "ESCALATED: OpenAI provider failed or exceeded SLA timeout.";
  } else if (!anthropicOk) {
    consensus = "ESCALATE_TO_HUMAN";
    reason = "ESCALATED: Anthropic provider failed or exceeded SLA timeout.";
  } else {
    // Both succeeded but their actions disagree
    consensus = "ESCALATE_TO_HUMAN";
    reason =
      `ESCALATED: Provider disagreement detected. ` +
      `OpenAI=${oaiResult!.parsed.action}, Anthropic=${antResult!.parsed.action}. ` +
      `Human review required.`;
  }

  // ── Assemble final result ────────────────────────────────────────────────────
  const decided_at = new Date().toISOString();

  const result: ConsensusResult = {
    consensus,
    decided_at,
    audit_hash: "", // populated after construction for self-referential hash
    openai: {
      action: openaiOk ? oaiResult!.parsed.action : "FAILED",
      confidence: openaiOk ? oaiResult!.parsed.confidence : null,
      rules_triggered: openaiOk ? oaiResult!.parsed.rules_triggered : null,
      latency_ms: openaiOk ? oaiResult!.latency_ms : 0,
      provider_id: openaiOk ? oaiResult!.provider_id : null,
    },
    anthropic: {
      action: anthropicOk ? antResult!.parsed.action : "FAILED",
      confidence: anthropicOk ? antResult!.parsed.confidence : null,
      rules_triggered: anthropicOk ? antResult!.parsed.rules_triggered : null,
      latency_ms: anthropicOk ? antResult!.latency_ms : 0,
      provider_id: anthropicOk ? antResult!.provider_id : null,
    },
    reason,
  };

  // ── Generate WORM audit hash ─────────────────────────────────────────────────
  //
  // The hash covers the complete result object (excluding the hash field itself)
  // plus the raw provider envelopes. This allows any downstream system to verify
  // that neither the decision nor the raw evidence has been tampered with.
  const auditPayload = {
    ...result,
    audit_hash: undefined, // exclude self-referential field before hashing
    _raw_openai_envelope: oaiResult?.raw_envelope ?? null,
    _raw_anthropic_envelope: antResult?.raw_envelope ?? null,
    _transaction_sha256: sha256Hex(transaction), // hash of original input
  };

  result.audit_hash = sha256Hex(auditPayload);

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 8 – n8n / CLI Entrypoint (optional self-test)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * When executed directly (ts-node ConsensusEngine.ts), runs a smoke test
 * against both providers with a synthetic high-risk transaction.
 *
 * In an n8n Code node, import and call runConsensus() directly.
 */
if (
  typeof require !== "undefined" &&
  typeof module !== "undefined" &&
  require.main === module
) {
  const SAMPLE_TRANSACTION = {
    transaction_id: "TXN-20240514-00887612",
    account_id: "ACC-00019234",
    amount_usd: 94_750.00,
    currency: "USD",
    merchant_category: "WIRE_TRANSFER",
    origin_country: "US",
    destination_country: "KY", // Cayman Islands – triggers GEO flags
    velocity_24h_usd: 210_000.00,
    account_age_days: 47,
    prior_disputes: 2,
    device_fingerprint_match: false,
    flagged_by_rules: ["VELOCITY-HIGH", "GEO-MISMATCH", "NEW-ACCOUNT"],
  };

  const SAMPLE_PROMPT = `
    You are evaluating a high-value wire transfer for AML and fraud risk.
    Flag any concerns with account age, velocity, geography, or dispute history.
    Apply FATF guidance and our internal rules: VELOCITY-HIGH (>$50k/24h),
    GEO-MISMATCH (origin/destination country risk delta > 2), NEW-ACCOUNT (<90 days).
  `.trim();

  (async () => {
    console.log("[ConsensusEngine] Starting consensus evaluation smoke test...\n");
    try {
      const result = await runConsensus(SAMPLE_TRANSACTION, SAMPLE_PROMPT);
      console.log("[ConsensusEngine] Final consensus result:");
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      // This path should never be reached given the fail-closed design,
      // but we catch here as a last-resort safety net.
      console.error("[ConsensusEngine] CRITICAL: Unhandled exception in runConsensus:", err);
      process.exit(1);
    }
  })();
}