// src/types.ts

// ---------------------------------------------------------------------------
// 1. Eligibility check result — the discriminated union checkEligibility
//    returns. Used at TWO independent call sites (initial decision, and
//    re-validation after SIGN_LOAN) — both switch on this with their own
//    assertUnreachable guard, so neither call site can silently drop a
//    branch even if the other one handles it correctly.
// ---------------------------------------------------------------------------

export interface CreditBureauProfile {
  readonly creditScore: number;
  readonly dbr: number; // debt burden ratio, as a percentage integer — e.g. 30 means 30%
  readonly fraudFlag: boolean;
  readonly blacklistStatus: boolean;
  readonly identityKey: string;
}

interface EligibilityResultBase {
  readonly profile: CreditBureauProfile;
}

export interface EligibilityAutoApprove extends EligibilityResultBase {
  readonly status: 'AUTO_APPROVE';
  readonly reason: 'PASSED_AUTO_APPROVE_THRESHOLDS';
}

export interface EligibilityAutoReject extends EligibilityResultBase {
  readonly status: 'AUTO_REJECT';
  /** Joined trigger codes — CREDIT_SCORE_BELOW_600, DBR_ABOVE_50, FRAUD_FLAG_TRUE, BLACKLIST_STATUS_TRUE — ported verbatim from Block 4.6. */
  readonly reason: string;
}

export interface EligibilityRequiresHitl extends EligibilityResultBase {
  readonly status: 'REQUIRES_HITL';
  /** Joined codes — AMOUNT_ABOVE_5M_OR_INVALID, SCORE_BELOW_700, DBR_AT_OR_ABOVE_40, or BORDERLINE_PROFILE — ported verbatim from Block 4.6. */
  readonly reason: string;
}

export type CreditEligibilityResult = EligibilityAutoApprove | EligibilityAutoReject | EligibilityRequiresHitl;

export function assertEligibilityUnreachable(value: never): never {
  throw new Error(`Unreachable eligibility result: ${JSON.stringify(value)}`);
}

// ---------------------------------------------------------------------------
// 2. Workflow input / final result
// ---------------------------------------------------------------------------

export interface CreditWorkflowInput {
  readonly traceId: string;
  readonly tenantId: string;
  readonly customerId: string;
  readonly customerEmail: string;
  readonly requestedAmountUzs: number;
}

export function buildCreditWorkflowId(traceId: string): string {
  return `credit-${traceId}`;
}

interface CreditOutcomeBase {
  readonly traceId: string;
}

export interface CreditAutoRejected extends CreditOutcomeBase {
  readonly status: 'AUTO_REJECTED';
  readonly reason: string;
}

export interface CreditHitlTimedOut extends CreditOutcomeBase {
  readonly status: 'HITL_TIMED_OUT';
}

export interface CreditHitlRejected extends CreditOutcomeBase {
  readonly status: 'HITL_REJECTED';
  readonly reviewerId: string;
  readonly reason: string;
}

export interface CreditSignatureTimedOut extends CreditOutcomeBase {
  readonly status: 'SIGNATURE_TIMED_OUT';
}

export interface CreditSignatureVerificationFailed extends CreditOutcomeBase {
  readonly status: 'SIGNATURE_VERIFICATION_FAILED';
  readonly errorDetail: string;
}

/**
 * Reached when re-validation (the SAME checkEligibility Activity, called
 * again on signal receipt per requirement #3) produces a DIFFERENT result
 * than the original decision — e.g. the customer's profile changed, or
 * got blacklisted, in the time between approval and signing. This is the
 * direct, structural answer to this platform's own established
 * Callback Rehydration Protocol rule: "the live result wins... routed to a
 * fresh proposal flow, not silently disbursed against stale terms."
 */
export interface CreditRevalidationFailed extends CreditOutcomeBase {
  readonly status: 'REVALIDATION_FAILED';
  readonly reason: string;
}

export interface CreditDisbursed extends CreditOutcomeBase {
  readonly status: 'DISBURSED';
  readonly transactionId: string;
  readonly providerReference: string;
  readonly disbursedAmountUzs: number;
}

export interface CreditDisbursementFailed extends CreditOutcomeBase {
  readonly status: 'DISBURSEMENT_FAILED';
  readonly errorDetail: string;
}

export type CreditWorkflowResult =
  | CreditAutoRejected
  | CreditHitlTimedOut
  | CreditHitlRejected
  | CreditSignatureTimedOut
  | CreditSignatureVerificationFailed
  | CreditRevalidationFailed
  | CreditDisbursed
  | CreditDisbursementFailed;

export function assertUnreachable(value: never): never {
  throw new Error(`Unreachable credit workflow result: ${JSON.stringify(value)}`);
}

// ---------------------------------------------------------------------------
// 3. Activity dependency interfaces — DI, same pattern as every prior VLAN.
// ---------------------------------------------------------------------------

export interface CreditBureauClient {
  /**
   * Mirrors Block 4.5's mock bureau exactly — same three test identities,
   * same fail-closed UNKNOWN_PROFILE for anything else. A real bureau
   * integration implements this interface later; nothing about the
   * interface shape needs to change when that happens.
   */
  lookupByIdentity(identityKey: string): Promise<Omit<CreditBureauProfile, 'identityKey'>>;
}

export interface DisbursementRequest {
  readonly traceId: string;
  readonly customerId: string;
  /** The bank's own account this service-level constant comes from — see activities.ts; never customer-supplied, never a placeholder fallback. */
  readonly creditAccountId: string;
  readonly amountUzs: number;
}

export interface DisbursementResult {
  readonly transactionId: string;
  readonly providerReference: string;
}

export interface CoreBankingClient {
  executeDisbursement(request: DisbursementRequest): Promise<DisbursementResult>;
}

export interface SignatureRequestNotice {
  readonly workflowId: string;
  readonly telegramChatId: string;
  readonly amountUzs: number;
}

export interface HitlPendingNotice {
  readonly workflowId: string;
  readonly telegramChatId: string;
}

export interface CreditNotifier {
  sendSignatureRequest(notice: SignatureRequestNotice, signedCallbackData: string): Promise<void>;
  sendHitlPendingNotice(notice: HitlPendingNotice): Promise<void>;
}

/**
 * Resolves a customer's actual disbursement target account. Deliberately
 * its own interface, not folded into CoreBankingClient — looking up WHERE
 * to send money and actually SENDING it are different operations with
 * different failure modes (a missing wallet registration is a
 * configuration/data problem, not a banking-rail transport problem).
 *
 * This is also the structural fix for the old flow's cross-domain leak:
 * the original `targetAccount` fallback chain reached into
 * `ticket.p2p_target_canonical` — a P2P-specific field this Credit
 * service has no business knowing about. That fallback is dropped
 * entirely here; a customer with no registered credit-disbursement
 * account is a hard failure, not a silent cross-domain field guess.
 */
export interface CustomerAccountDirectory {
  resolveCreditDisbursementAccount(customerId: string): Promise<string>;
}

export interface CreditActivityDependencies {
  readonly bureauClient: CreditBureauClient;
  readonly coreBankingClient: CoreBankingClient;
  readonly notifier: CreditNotifier;
  readonly accountDirectory: CustomerAccountDirectory;
  readonly signatureSecretKey: Uint8Array; // pre-encoded once at worker startup, same rationale as P2P's confirmationSecretKey
  /** The bank's own funding source account for disbursements — a service-level constant, not customer input. Injected so it's config, not a hardcoded literal buried in logic. */
  readonly disbursementSourceAccountId: string;
}