// activities.ts — Trunk 1: P2P Execution & Compliance
//
// Contract definitions only, per this task's explicit scope. Every
// activity is exported as a strict interface plus a literal mock that
// always succeeds — wired directly into worker.ts. The mock bodies carry
// no business logic; the orchestration logic surrounding them in
// workflows.ts is written for the real eventual implementation, not just
// to satisfy today's trivial mock.
//
// FIVE activities, not four. See the conversational note above for why
// `computeFraudVectorToken` had to be added: the stated compliance
// constraint ("verifyFraudVector must not accept raw PII") is otherwise
// unenforceable — nothing would exist to PRODUCE the salted token in the
// first place. This is also the ONLY activity in this entire file that
// ever sees a device fingerprint, an IP address, or a session ID — and it
// runs exclusively on p2p-queue, inside the bank's own perimeter.

// ---------------------------------------------------------------------------
// 1. Titanium Sanitizer — local, deterministic, threat detection.
//    Threat categories ported directly from the original REVENANT V31
//    audit's "BLOCK 0: Titanium Sanitizer" (SQLi, XSS, prompt injection,
//    "Authority Poisoning" / CEO-fraud detection).
// ---------------------------------------------------------------------------

export const THREAT_CATEGORIES = ['SQL_INJECTION', 'XSS', 'PROMPT_INJECTION', 'AUTHORITY_POISONING'] as const;
export type ThreatCategory = (typeof THREAT_CATEGORIES)[number];

export interface TitaniumSanitizerInput {
  readonly traceId: string;
  readonly rawPayloadText: string;
}

/**
 * Deliberately minimal on the success path — see the conversational note:
 * this activity THROWS on detection rather than returning a discriminated
 * result, because a confirmed attack payload is an integrity/security
 * event, not a normal business outcome to branch on.
 */
export interface TitaniumSanitizerOutput {
  readonly scanned: true;
  readonly patternsEvaluated: number;
}

// ---------------------------------------------------------------------------
// 2. Fraud vector — the privacy-critical boundary. SaltedHmacToken is a
//    BRANDED type, not a plain string. Branding is a compile-time-only
//    guardrail — it prevents ACCIDENTAL misuse (passing a raw deviceId
//    variable where a token is expected without an explicit, reviewable
//    `as` cast) but is not a runtime guarantee a determined caller
//    couldn't force past with a cast. The actual runtime guarantee is
//    that ONLY computeFraudVectorToken's real implementation ever
//    produces one of these, the same "only this function can mint this
//    shape" discipline used for F8's sanitizedImageRef. Honest scope
//    limit, stated plainly rather than oversold.
// ---------------------------------------------------------------------------

export type SaltedHmacToken = string & { readonly __brand: 'SaltedHmacToken' };

/** Internal constructor — exported so the mock/real implementation can produce a value of this type; not intended for use outside an activity implementation. */
export function toSaltedHmacToken(hex: string): SaltedHmacToken {
  return hex as SaltedHmacToken;
}

/**
 * Reserved, unimplemented placeholder for a future zero-knowledge-proof
 * scheme — the task names this as an alternative to a salted HMAC. Kept
 * as a real branch of the union rather than omitted, the same "hold a
 * slot in the type system for a named-but-not-yet-built path" discipline
 * used for F7/F8's mocked dependencies.
 */
export interface ZkProofPayload {
  readonly scheme: string;
  readonly proof: string; // opaque, base64-encoded — not implemented
  readonly publicInputs: readonly string[];
}

export type FraudVectorPayload =
  | { readonly scheme: 'SALTED_HMAC'; readonly token: SaltedHmacToken }
  | { readonly scheme: 'ZKP'; readonly proof: ZkProofPayload };

/**
 * Coarse amount tiers, not an exact figure — see the conversational note
 * on why exact amount is itself a correlation risk once pooled across
 * 40+ participating banks. This is the ONLY shape an amount is allowed to
 * take once it crosses into the platform-queue fraud check.
 */
export const TRANSACTION_AMOUNT_BANDS = ['UNDER_100K', 'BETWEEN_100K_AND_1M', 'BETWEEN_1M_AND_10M', 'OVER_10M'] as const;
export type TransactionAmountBand = (typeof TRANSACTION_AMOUNT_BANDS)[number];

export interface ComputeFraudVectorTokenInput {
  readonly traceId: string;
  // RAW PII. Legitimate to appear ONLY in this one interface, because this
  // is the one activity guaranteed (by task-queue routing in workflows.ts)
  // to execute exclusively inside the BYOC perimeter.
  readonly deviceFingerprint: string;
  readonly ipAddress: string;
  readonly sessionId: string;
}
export interface ComputeFraudVectorTokenOutput {
  readonly fraudVector: FraudVectorPayload;
}

export interface VerifyFraudVectorInput {
  readonly traceId: string;
  /** WHICH bank originated this signal — necessary for a cross-bank network to function at all, and not PII in the sense this constraint is guarding against (it identifies an institution, not a customer). */
  readonly tenantId: string;
  readonly fraudVector: FraudVectorPayload;
  readonly transactionAmountBand: TransactionAmountBand;
}

export type VerifyFraudVectorOutput =
  | { readonly outcome: 'CLEAN'; readonly networkRiskScore: number }
  | { readonly outcome: 'FLAGGED'; readonly networkRiskScore: number; readonly matchedParticipantCount: number };

// ---------------------------------------------------------------------------
// 3. AML/PEP screening — deliberately NOT subject to the same PII-exclusion
//    typing as the fraud vector. Sanctions/PEP screening structurally
//    requires a real name to check against a real list — you cannot
//    screen a hash against OFAC. This is the platform's own internal
//    compliance check (consistent with the original audit's "HTTP:
//    PEP/Sanctions API"), not a pooled cross-institution signal — the two
//    remote calls in this file have genuinely different privacy postures
//    for principled, not arbitrary, reasons.
// ---------------------------------------------------------------------------

export type ComplianceSubjectRole = 'SENDER' | 'RECIPIENT';

export interface AmlPepScreeningSubject {
  readonly role: ComplianceSubjectRole;
  readonly fullName: string;
}

export interface AmlPepScreeningInput {
  readonly traceId: string;
  readonly tenantId: string;
  readonly subjects: readonly AmlPepScreeningSubject[];
}

export type AmlPepScreeningOutput =
  | { readonly outcome: 'CLEAR' }
  | { readonly outcome: 'MATCH_FOUND'; readonly matchedRole: ComplianceSubjectRole; readonly listSource: string };

// ---------------------------------------------------------------------------
// 4. Ledger execution — fail-closed. The discriminated SUCCESS/FAILED
//    shape plus the workflow's own try/catch mapping (workflows.ts) IS
//    the fail-closed mechanism: there is no code path in which an
//    ambiguous or thrown outcome from this activity is ever interpreted
//    as a successful transfer.
// ---------------------------------------------------------------------------

export interface ExecuteLedgerTransferInput {
  readonly traceId: string;
  readonly idempotencyKey: string;
  readonly senderAccountRef: string;
  readonly recipientAccountRef: string;
  readonly amountUzs: string;
}

export type ExecuteLedgerTransferOutput =
  | { readonly outcome: 'SUCCESS'; readonly transactionId: string; readonly ledgerSequenceNumber: string }
  | { readonly outcome: 'FAILED'; readonly reason: string };

// ---------------------------------------------------------------------------
// 5. Activity interface groupings — split by trust boundary / task queue,
//    not by feature. This split IS the security architecture: anything
//    in LocalP2PActivities is implemented and registered ONLY inside
//    BYOC; anything in PlatformComplianceActivities is implemented and
//    registered ONLY in the SaaS Edge. worker.ts (this deliverable)
//    imports and registers LocalP2PActivities exclusively.
// ---------------------------------------------------------------------------

export interface LocalP2PActivities {
  runTitaniumSanitizer(input: TitaniumSanitizerInput): Promise<TitaniumSanitizerOutput>;
  computeFraudVectorToken(input: ComputeFraudVectorTokenInput): Promise<ComputeFraudVectorTokenOutput>;
  executeLedgerTransfer(input: ExecuteLedgerTransferInput): Promise<ExecuteLedgerTransferOutput>;
}

export interface PlatformComplianceActivities {
  runAmlPepScreening(input: AmlPepScreeningInput): Promise<AmlPepScreeningOutput>;
  verifyFraudVector(input: VerifyFraudVectorInput): Promise<VerifyFraudVectorOutput>;
}

// ---------------------------------------------------------------------------
// Mock implementations — trivial, always-succeed bodies, per task scope.
// localActivityMocks is what worker.ts actually registers.
// platformActivityMocks is defined here only for shared-contract
// completeness (a future SaaS Edge worker, out of scope for this
// deliverable, would import and register it) — worker.ts below never
// touches it.
// ---------------------------------------------------------------------------

export const localActivityMocks: LocalP2PActivities = {
  async runTitaniumSanitizer(_input) {
    return { scanned: true, patternsEvaluated: 0 };
  },
  async computeFraudVectorToken(_input) {
    // Real implementation: HMAC-SHA256 over the raw signals, keyed by a
    // per-tenant secret resolved from Vault at worker startup — the same
    // pre-encoded-once-at-startup pattern as every other signing key in
    // this codebase (P2P's confirmationSecretKey, Credit's
    // signatureSecretKey, F7's identityContextSigningKey).
    return { fraudVector: { scheme: 'SALTED_HMAC', token: toSaltedHmacToken('0'.repeat(64)) } };
  },
  async executeLedgerTransfer(input) {
    return {
      outcome: 'SUCCESS',
      transactionId: `MOCK-TX-${input.idempotencyKey}`,
      ledgerSequenceNumber: '0',
    };
  },
};

export const platformActivityMocks: PlatformComplianceActivities = {
  async runAmlPepScreening(_input) {
    return { outcome: 'CLEAR' };
  },
  async verifyFraudVector(_input) {
    return { outcome: 'CLEAN', networkRiskScore: 0 };
  },
};