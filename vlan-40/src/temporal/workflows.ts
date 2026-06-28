// src/temporal/workflows.ts

import {
  proxyActivities,
  defineSignal,
  defineQuery,
  setHandler,
  condition,
  workflowInfo,
  ApplicationFailure,
} from '@temporalio/workflow';
import type { CreditActivities } from './activities';
import type { CreditWorkflowInput, CreditWorkflowResult, CreditEligibilityResult } from '../types';
import { assertUnreachable, assertEligibilityUnreachable } from '../types';

// ---------------------------------------------------------------------------
// Retry policies — four distinct profiles. The disbursement policy is the
// one requirement #4 specifies explicitly; the other three are scoped by
// the same risk-based reasoning applied consistently across every VLAN in
// this build so far (fast/low-risk vs. external-provider vs. financial-execution).
// ---------------------------------------------------------------------------

const eligibilityActivities = proxyActivities<CreditActivities>({
  startToCloseTimeout: '5 seconds',
  retry: {
    initialInterval: '500ms',
    backoffCoefficient: 2,
    maximumInterval: '5 seconds',
    maximumAttempts: 4,
  },
});

const accountResolutionActivities = proxyActivities<CreditActivities>({
  startToCloseTimeout: '5 seconds',
  retry: {
    initialInterval: '500ms',
    backoffCoefficient: 2,
    maximumInterval: '5 seconds',
    maximumAttempts: 4,
    nonRetryableErrorTypes: ['CONFIGURATION_ERROR'],
  },
});

const signatureActivities = proxyActivities<CreditActivities>({
  startToCloseTimeout: '5 seconds',
  retry: {
    initialInterval: '500ms',
    backoffCoefficient: 2,
    maximumInterval: '5 seconds',
    maximumAttempts: 4,
    nonRetryableErrorTypes: ['CALLBACK_VERIFICATION_FAILED'],
  },
});

/**
 * The conservative, requirement-#4 policy. maximumAttempts: 2, exactly as
 * specified — NOT Temporal's more liberal defaults, and deliberately no
 * exponential backoff curve tuned for patience, since patience isn't the
 * goal here. A failed disbursement attempt should reach the workflow's own
 * DISBURSEMENT_FAILED branch quickly and escalate to manual reconciliation
 * — it should not retry blindly into a possible double-disbursement.
 */
const disbursementActivities = proxyActivities<CreditActivities>({
  startToCloseTimeout: '15 seconds',
  retry: {
    initialInterval: '1 second',
    backoffCoefficient: 1,
    maximumAttempts: 2,
  },
});

const { checkEligibility } = eligibilityActivities;
const { resolveDisbursementAccount } = accountResolutionActivities;
const { issueSignatureToken, dispatchSignatureRequest, dispatchHitlPendingNotice, verifySignatureToken } =
  signatureActivities;
const { executeDisbursement } = disbursementActivities;

// ---------------------------------------------------------------------------
// Signals & Query
// ---------------------------------------------------------------------------

export interface SignLoanSignalPayload {
  readonly rawToken: string;
}

/**
 * NOT present in the old n8n flow — added because, as exported, there was
 * no mechanism anywhere for a REQUIRES_HITL decision to ever resolve. See
 * the conversational note above this code for the full reasoning. A human
 * reviewer can optionally adjust the approved amount down from what was
 * originally requested; they cannot adjust it up without a fresh
 * application, which is enforced by amountUzs being capped at the
 * workflow's own requestedAmountUzs at the call site below, not trusted
 * blindly from the signal payload.
 */
export interface HumanReviewDecisionSignalPayload {
  readonly approved: boolean;
  readonly reviewerId: string;
  readonly approvedAmountUzs?: number;
}

export const signLoanSignal = defineSignal<[SignLoanSignalPayload]>('signLoan');
export const humanReviewDecisionSignal = defineSignal<[HumanReviewDecisionSignalPayload]>('humanReviewDecision');

export type CreditWorkflowStatusSnapshot =
  | { phase: 'AWAITING_HITL_REVIEW' }
  | { phase: 'AWAITING_SIGNATURE' }
  | { phase: 'PROCESSING_DISBURSEMENT' }
  | { phase: 'COMPLETE'; result: CreditWorkflowResult };

export const getCreditStatusQuery = defineQuery<CreditWorkflowStatusSnapshot>('getStatus');

const HITL_REVIEW_TIMEOUT = '48 hours'; // a credit-underwriting-specific SLA — deliberately NOT reusing the platform's unrelated 15-minute generic approval-dispatch timeout; see conversational note
const SIGNATURE_WAIT_TIMEOUT = '24 hours'; // matches the JWT's own expiry set in activities.ts

// ---------------------------------------------------------------------------
// Workflow
// ---------------------------------------------------------------------------

export async function CreditDecisionWorkflow(input: CreditWorkflowInput): Promise<CreditWorkflowResult> {
  const workflowId = workflowInfo().workflowId;

  let signLoanPayload: SignLoanSignalPayload | null = null;
  let humanReviewPayload: HumanReviewDecisionSignalPayload | null = null;
  let statusSnapshot: CreditWorkflowStatusSnapshot = { phase: 'AWAITING_HITL_REVIEW' };

  setHandler(signLoanSignal, (payload) => {
    signLoanPayload = payload;
  });
  setHandler(humanReviewDecisionSignal, (payload) => {
    humanReviewPayload = payload;
  });
  setHandler(getCreditStatusQuery, () => statusSnapshot);

  // Step 1 — Initial eligibility check.
  const initialResult: CreditEligibilityResult = await checkEligibility({
    customerEmail: input.customerEmail,
    requestedAmountUzs: input.requestedAmountUzs,
  });

  // approvedAmountUzs starts as the requested amount; only a human
  // reviewer (never the customer, never the original token) can lower it.
  let approvedAmountUzs = input.requestedAmountUzs;

  // First exhaustiveness checkpoint — guards the INITIAL decision.
  switch (initialResult.status) {
    case 'AUTO_REJECT': {
      const result: CreditWorkflowResult = {
        status: 'AUTO_REJECTED',
        traceId: input.traceId,
        reason: initialResult.reason,
      };
      statusSnapshot = { phase: 'COMPLETE', result };
      return result;
    }

    case 'REQUIRES_HITL': {
      statusSnapshot = { phase: 'AWAITING_HITL_REVIEW' };
      await dispatchHitlPendingNotice({ workflowId, telegramChatId: input.customerId });

      const settled = await condition(() => humanReviewPayload !== null, HITL_REVIEW_TIMEOUT);

      if (!settled || humanReviewPayload === null) {
        const result: CreditWorkflowResult = { status: 'HITL_TIMED_OUT', traceId: input.traceId };
        statusSnapshot = { phase: 'COMPLETE', result };
        return result;
      }

      // Assert the type now that we know it is not null
      const payload = humanReviewPayload as HumanReviewDecisionSignalPayload;

      if (!payload.approved) {
        const result: CreditWorkflowResult = {
          status: 'HITL_REJECTED',
          traceId: input.traceId,
          reviewerId: payload.reviewerId,
          reason: 'REJECTED_BY_HUMAN_REVIEWER',
        };
        statusSnapshot = { phase: 'COMPLETE', result };
        return result;
      }

      // Human approved — optionally at a reduced amount.
      if (
        payload.approvedAmountUzs !== undefined &&
        payload.approvedAmountUzs > 0 &&
        payload.approvedAmountUzs <= input.requestedAmountUzs
      ) {
        approvedAmountUzs = payload.approvedAmountUzs;
      }
      // Falls through into the shared signature/disbursement flow below.
      break;
    }

    case 'AUTO_APPROVE': {
      // approvedAmountUzs already equals input.requestedAmountUzs; falls
      // through into the shared flow below.
      break;
    }

    default:
      assertEligibilityUnreachable(initialResult);
  }

  // Step 2 — Shared signature + disbursement flow, reached by either
  // AUTO_APPROVE or a human-approved HITL case.
  statusSnapshot = { phase: 'AWAITING_SIGNATURE' };

  const { signedToken } = await issueSignatureToken({
    workflowId,
    customerId: input.customerId,
    amountUzs: approvedAmountUzs,
  });

  await dispatchSignatureRequest({
    workflowId,
    telegramChatId: input.customerId,
    amountUzs: approvedAmountUzs,
    signedToken,
  });

  const signatureSettled = await condition(() => signLoanPayload !== null, SIGNATURE_WAIT_TIMEOUT);

  if (!signatureSettled || signLoanPayload === null) {
    const result: CreditWorkflowResult = { status: 'SIGNATURE_TIMED_OUT', traceId: input.traceId };
    statusSnapshot = { phase: 'COMPLETE', result };
    return result;
  }

  // Assert the type now that we know it is not null
  const payload = signLoanPayload as SignLoanSignalPayload;

  statusSnapshot = { phase: 'PROCESSING_DISBURSEMENT' };

  let verifiedClaims: { customerId: string; amountUzs: number };
  try {
    verifiedClaims = await verifySignatureToken(payload.rawToken, workflowId);
  }catch (err) {
    const result: CreditWorkflowResult = {
      status: 'SIGNATURE_VERIFICATION_FAILED',
      traceId: input.traceId,
      errorDetail: err instanceof ApplicationFailure ? err.message : 'Signature verification failed.',
    };
    statusSnapshot = { phase: 'COMPLETE', result };
    return result;
  }

  // Step 3 — Re-validation. THE SAME checkEligibility Activity, called a
  // second time, per requirement #3 — not a copy of the logic.
  const revalidationResult: CreditEligibilityResult = await checkEligibility({
    customerEmail: input.customerEmail,
    requestedAmountUzs: verifiedClaims.amountUzs,
  });

  // Second exhaustiveness checkpoint — guards the RE-VALIDATION result
  // independently of the first switch above. A decision dropped here
  // would mean disbursing against stale terms, which is precisely what
  // this whole re-validation step exists to prevent.
  switch (revalidationResult.status) {
    case 'AUTO_APPROVE':
      break; // live result confirms the original decision — proceed to disbursement.

    case 'AUTO_REJECT':
    case 'REQUIRES_HITL': {
      // The live result no longer agrees with the stale token's terms —
      // per the established Callback Rehydration Protocol, the live
      // result wins. Disbursement does NOT proceed.
      const result: CreditWorkflowResult = {
        status: 'REVALIDATION_FAILED',
        traceId: input.traceId,
        reason: `Eligibility changed since approval: ${revalidationResult.reason}`,
      };
      statusSnapshot = { phase: 'COMPLETE', result };
      return result;
    }

    default:
      assertEligibilityUnreachable(revalidationResult);
  }

  // Step 4 — Resolve the disbursement target account. No fallback to a
  // P2P field or a placeholder account — see types.ts's
  // CustomerAccountDirectory comment.
  let creditAccountId: string;
  try {
    creditAccountId = await resolveDisbursementAccount(verifiedClaims.customerId);
  } catch (err) {
    const result: CreditWorkflowResult = {
      status: 'DISBURSEMENT_FAILED',
      traceId: input.traceId,
      errorDetail: err instanceof ApplicationFailure ? err.message : 'Could not resolve disbursement account.',
    };
    statusSnapshot = { phase: 'COMPLETE', result };
    return result;
  }

  // Step 5 — Disburse. The conservative, 2-attempt policy.
  try {
    const disbursement = await executeDisbursement({
      traceId: input.traceId,
      customerId: verifiedClaims.customerId,
      creditAccountId,
      amountUzs: verifiedClaims.amountUzs,
    });

    const result: CreditWorkflowResult = {
      status: 'DISBURSED',
      traceId: input.traceId,
      transactionId: disbursement.transactionId,
      providerReference: disbursement.providerReference,
      disbursedAmountUzs: verifiedClaims.amountUzs,
    };
    statusSnapshot = { phase: 'COMPLETE', result };
    return result;
  } catch (err) {
    const result: CreditWorkflowResult = {
      status: 'DISBURSEMENT_FAILED',
      traceId: input.traceId,
      errorDetail: err instanceof ApplicationFailure ? err.message : 'Disbursement failed after exhausting retries.',
    };
    statusSnapshot = { phase: 'COMPLETE', result };
    return result;
  }
}

/** Exhaustiveness self-check, mirroring the pattern established for P2P's describeOutcome. */
export function describeOutcome(result: CreditWorkflowResult): string {
  switch (result.status) {
    case 'AUTO_REJECTED':
      return `Auto-rejected: ${result.reason}`;
    case 'HITL_TIMED_OUT':
      return 'No human review decision received within the SLA window.';
    case 'HITL_REJECTED':
      return `Rejected by reviewer ${result.reviewerId}: ${result.reason}`;
    case 'SIGNATURE_TIMED_OUT':
      return 'No e-signature received within the TTL window.';
    case 'SIGNATURE_VERIFICATION_FAILED':
      return `Signature verification failed: ${result.errorDetail}`;
    case 'REVALIDATION_FAILED':
      return `Re-validation failed: ${result.reason}`;
    case 'DISBURSED':
      return `Disbursed ${result.disbursedAmountUzs} UZS as transaction ${result.transactionId}.`;
    case 'DISBURSEMENT_FAILED':
      return `Disbursement failed: ${result.errorDetail}`;
    default:
      return assertUnreachable(result);
  }
}