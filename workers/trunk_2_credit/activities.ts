/**
 * activities.ts
 *
 * REVENANT v32 — Trunk 2: Credit Execution
 * Activity contracts only. No business logic lives here — every exported
 * function is a mock that returns a deterministic success shape so that
 * `workflows.ts` and `worker.ts` can be developed and type-checked against
 * a stable surface while the real implementations (signature crypto, ledger
 * I/O, AML/fraud provider calls) are built out behind these same contracts.
 *
 * Hybrid BYOC Isolation Model
 * ------------------------------------------------------------------------
 * Activities in this file fall into exactly two trust domains, and the
 * grouping below is load-bearing — it is what `workflows.ts` uses to bind
 * each function to the correct `taskQueue` via `proxyActivities`:
 *
 *   LOCAL  (poll `credit-queue`)   — executed inside the bank's own K8s
 *                                    perimeter (e.g. MikroKreditBANK). Only
 *                                    these activities may touch raw PII,
 *                                    raw credentials, or move money.
 *
 *   REMOTE (poll `platform-queue`) — executed in the centralized SaaS Edge.
 *                                    Computationally heavy (LLM consensus,
 *                                    AI scoring, global network lookups) but
 *                                    must never receive raw customer PII —
 *                                    only pre-tokenized/hashed material that
 *                                    was prepared by a LOCAL activity.
 *
 * This file deliberately keeps both groups in one module (single source of
 * truth for the contracts), while `worker.ts` imports and registers only
 * the LOCAL group, and `workflows.ts` proxies each group to its own queue
 * with its own retry posture.
 */

// ---------------------------------------------------------------------------
// Branded types
// ---------------------------------------------------------------------------

declare const SaltedHmacTokenBrand: unique symbol;

/**
 * A salted HMAC token over device/network fraud signals. Minted exclusively
 * by the LOCAL `computeFraudVectorToken` activity, which is the only code
 * path permitted to read the raw `deviceId` / `sourceIp` / `phoneNumber`
 * inputs. The brand makes it a compile-time error to pass a plain `string`
 * (e.g. a raw device ID) anywhere a `SaltedHmacToken` is expected — in
 * particular into `verifyFraudVector`, which crosses into the SaaS Edge.
 */
export type SaltedHmacToken = string & { readonly [SaltedHmacTokenBrand]: true };

/** Internal-only constructor; intentionally not exported. */
function brandSaltedHmacToken(value: string): SaltedHmacToken {
    return value as SaltedHmacToken;
}

/**
 * CBU data-classification tiers carried through the workflow so that every
 * remote hop can be evaluated against data-localization policy.
 */
export type DataClassificationTier = 'PUBLIC' | 'INTERNAL' | 'CONFIDENTIAL' | 'RESTRICTED';

// ---------------------------------------------------------------------------
// LOCAL ACTIVITIES — poll `credit-queue` (BYOC core, inside bank perimeter)
// ---------------------------------------------------------------------------

/** Step 1: Request Verification. */
export interface VerifyRequestSignatureInput {
    readonly applicationId: string;
    /** Canonical (stable-key-order) JSON serialization of the inbound application body. */
    readonly canonicalPayload: string;
    /** Base64-encoded signature over `canonicalPayload`. */
    readonly signatureBase64: string;
    /** Reference to the signing key in the bank's local HSM/KMS — never the raw key material. */
    readonly signingKeyId: string;
}

export interface VerifyRequestSignatureResult {
    readonly valid: boolean;
    readonly signingKeyId: string;
    readonly verifiedAtIso: string;
}

/**
 * Cryptographically verifies the integrity of the inbound credit application
 * before any downstream processing occurs. A `valid: false` result indicates
 * either corruption in transit or active tampering and must be treated as a
 * security event by the caller.
 *
 * MOCK: always reports a valid signature.
 */
export async function verifyRequestSignature(
    input: VerifyRequestSignatureInput,
): Promise<VerifyRequestSignatureResult> {
    // Production: resolve `signingKeyId` via local HSM/KMS, recompute the
    // digest over `canonicalPayload`, and verify `signatureBase64` against it
    // using a constant-time comparison.
    return {
        valid: true,
        signingKeyId: input.signingKeyId,
        verifiedAtIso: new Date().toISOString(),
    };
}

/** Tokenization step that gates Step 3's cross-perimeter fraud lookup. */
export interface ComputeFraudVectorTokenInput {
    readonly applicationId: string;
    /** Raw PII — must never leave this activity's process boundary unhashed. */
    readonly deviceId: string;
    readonly sourceIp: string;
    readonly phoneNumber: string;
    /** Reference to the salt material in the bank's local HSM/KMS. */
    readonly saltKeyId: string;
}

export interface ComputeFraudVectorTokenResult {
    readonly fraudVectorToken: SaltedHmacToken;
    readonly saltKeyId: string;
}

/**
 * Derives a salted HMAC token from raw device/network fraud signals. This is
 * the single chokepoint through which fraud-relevant PII is allowed to
 * become eligible for transmission to the SaaS Edge — by the time anything
 * leaves this activity, it is an opaque, irreversible token, never the raw
 * value.
 *
 * MOCK: returns a deterministic placeholder token.
 */
export async function computeFraudVectorToken(
    input: ComputeFraudVectorTokenInput,
): Promise<ComputeFraudVectorTokenResult> {
    // Production: token = HMAC-SHA256(key = HSM-resolved salt for `saltKeyId`,
    // message = normalized(deviceId, sourceIp, phoneNumber)), base64url-encoded.
    return {
        fraudVectorToken: brandSaltedHmacToken(`mock-fvt:${input.applicationId}`),
        saltKeyId: input.saltKeyId,
    };
}

/** Step 4: e-Signature Validation. */
export interface VerifyLoanSignatureInput {
    readonly applicationId: string;
    /** Hash of the captured e-signature/consent artifact presented at signing time. */
    readonly capturedSignatureHash: string;
    /** Opaque token issued to the client at consent capture, naming the authorized signature. */
    readonly authorizedSignatureToken: string;
}

export interface VerifyLoanSignatureResult {
    readonly matched: boolean;
    readonly verifiedAtIso: string;
}

/**
 * Matches the client's captured loan signature against the authorized
 * signature token recorded at consent time. A `matched: false` result must
 * be treated as a security event by the caller — it indicates either signer
 * mismatch or replay of a stale consent artifact.
 *
 * MOCK: always reports a match.
 */
export async function verifyLoanSignature(
    input: VerifyLoanSignatureInput,
): Promise<VerifyLoanSignatureResult> {
    // Production: re-derive the expected hash from the authorized token's
    // bound artifact and compare against `capturedSignatureHash` in constant time.
    return {
        matched: input.authorizedSignatureToken.length > 0,
        verifiedAtIso: new Date().toISOString(),
    };
}

/** Step 5: Credit Disbursement Ledger. */
export interface ExecuteCreditDisbursementInput {
    readonly applicationId: string;
    readonly disbursementAccountIban: string;
    /**
     * Disbursement amount in UZS. ALWAYS a string — never `number` — across
     * every interface in this module, to eliminate floating-point precision
     * and JSON/gRPC serialization risk for monetary values.
     */
    readonly amountUzs: string;
    /** Caller-supplied idempotency key; the ledger must treat this as a dedupe boundary. */
    readonly idempotencyKey: string;
}

export interface ExecuteCreditDisbursementResult {
    readonly status: 'DISBURSED' | 'FAILED';
    readonly ledgerTransactionId: string;
    readonly disbursedAtIso: string;
}

/**
 * Executes the fail-closed credit transfer that disburses loan funds into
 * the client's account. This activity owns disbursement authority and must
 * never run outside the BYOC perimeter.
 *
 * MOCK: always reports success.
 */
export async function executeCreditDisbursement(
    input: ExecuteCreditDisbursementInput,
): Promise<ExecuteCreditDisbursementResult> {
    // Production: submit a single, idempotency-keyed ledger transfer; on any
    // ambiguous response (timeout, partial ack) the activity must surface
    // FAILED rather than guess, so the workflow's fail-closed retry policy
    // (see ledgerExecutionActivities in workflows.ts) governs the outcome.
    return {
        status: 'DISBURSED',
        ledgerTransactionId: `ltx_${input.applicationId}_${input.idempotencyKey}`,
        disbursedAtIso: new Date().toISOString(),
    };
}

// ---------------------------------------------------------------------------
// REMOTE ACTIVITIES — poll `platform-queue` (SaaS Edge, centralized cloud)
// ---------------------------------------------------------------------------

/** Step 2: AI Credit Eligibility. */
export interface EvaluateAiCreditEligibilityInput {
    readonly applicationId: string;
    /** String, per the project-wide monetary-amount convention. */
    readonly requestedAmountUzs: string;
    /** Pre-masked/derived context only — never raw identity documents. */
    readonly applicantContext: Readonly<Record<string, string | number | boolean>>;
    readonly dataClassification: DataClassificationTier;
}

export interface EvaluateAiCreditEligibilityResult {
    readonly eligible: boolean;
    readonly riskScore: number;
    /** Identifier of the multi-model consensus run (Trunk 5a/5b LLM fallback pool) that produced this result. */
    readonly modelConsensusId: string;
    readonly reasonCodes: readonly string[];
}

/**
 * Dispatches application context to the SaaS Edge for AI credit scoring,
 * resolved via the shared LLM fallback pool (OpenRouter primary, self-hosted
 * fallback on dual-cloud failure).
 *
 * MOCK: always reports eligible with a nominal risk score.
 */
export async function evaluateAiCreditEligibility(
    input: EvaluateAiCreditEligibilityInput,
): Promise<EvaluateAiCreditEligibilityResult> {
    return {
        eligible: true,
        riskScore: 12,
        modelConsensusId: `consensus_${input.applicationId}`,
        reasonCodes: [],
    };
}

/** Step 3a: AML/PEP screening (Cross-Perimeter Compliance). */
export interface RunAmlPepScreeningInput {
    readonly applicationId: string;
    /** Hashed, never raw, identity fields — produced locally before this call. */
    readonly fullNameHash: string;
    readonly nationalIdHash: string;
    readonly dateOfBirthIso: string;
}

export interface RunAmlPepScreeningResult {
    readonly status: 'CLEAR' | 'PEP_MATCH' | 'AML_HIT' | 'INCONCLUSIVE';
    readonly screeningProviderRef: string;
    readonly screenedAtIso: string;
}

/**
 * Performs AML (Anti-Money Laundering) and PEP (Politically Exposed Person)
 * lookups against the centralized compliance provider.
 *
 * MOCK: always reports clear.
 */
export async function runAmlPepScreening(
    input: RunAmlPepScreeningInput,
): Promise<RunAmlPepScreeningResult> {
    return {
        status: 'CLEAR',
        screeningProviderRef: `aml_${input.applicationId}`,
        screenedAtIso: new Date().toISOString(),
    };
}

/** Step 3b: Global Fraud Network lookup (Cross-Perimeter Compliance). */
export interface VerifyFraudVectorInput {
    readonly applicationId: string;
    /**
     * MUST be the branded token produced by the LOCAL `computeFraudVectorToken`
     * activity. The type system makes it impossible to pass a raw device ID,
     * IP address, or phone number here — this signature is the enforcement
     * boundary for "no raw PII crosses into the SaaS Edge".
     */
    readonly fraudVectorToken: SaltedHmacToken;
}

export interface VerifyFraudVectorResult {
    readonly status: 'CLEAR' | 'FLAGGED' | 'BLOCKED';
    readonly globalNetworkRef: string;
    readonly screenedAtIso: string;
}

/**
 * Queries the Global Fraud Network using only the pre-tokenized fraud
 * vector — never raw device/network signals.
 *
 * MOCK: always reports clear.
 */
export async function verifyFraudVector(
    input: VerifyFraudVectorInput,
): Promise<VerifyFraudVectorResult> {
    return {
        status: 'CLEAR',
        globalNetworkRef: `gfn_${input.applicationId}`,
        screenedAtIso: new Date().toISOString(),
    };
}

// ---------------------------------------------------------------------------
// DOMAIN-SPECIFIC BUNDLES
// These objects freeze the perimeters so that worker.ts and workflows.ts
// can safely register and proxy them without mixing up trust boundaries.
// ---------------------------------------------------------------------------

export const localActivities = Object.freeze({
    verifyRequestSignature,
    computeFraudVectorToken,
    verifyLoanSignature,
    executeCreditDisbursement,
});

export const remoteActivities = Object.freeze({
    evaluateAiCreditEligibility,
    runAmlPepScreening,
    verifyFraudVector,
});

// Export type shapes for proxyActivities inside workflows.ts
// This provides absolute auto-complete type safety without importing implementation bodies.
export type LocalActivitiesType = typeof localActivities;
export type RemoteActivitiesType = typeof remoteActivities;