// src/temporal/workflows.ts

import { proxyActivities, defineSignal, defineQuery, setHandler, condition, workflowInfo } from '@temporalio/workflow';
import type { MerchantActivities } from './activities';
import type { MerchantCheckoutWorkflowInput, MerchantCheckoutWorkflowResult } from '../types';
import { assertUnreachable, assertVerificationUnreachable } from '../types';

// ---------------------------------------------------------------------------
// Retry policies — three profiles, scoped by risk exactly as established
// across every other VLAN in this build.
// ---------------------------------------------------------------------------

/** Verification: fast, DB-backed, low risk. */
const verificationActivities = proxyActivities<MerchantActivities>({
  startToCloseTimeout: '3 seconds',
  retry: {
    initialInterval: '250ms',
    backoffCoefficient: 2,
    maximumInterval: '2 seconds',
    maximumAttempts: 3,
  },
});

/** QR generation: local, in-process, no network — fast timeout, modest retry purely against transient resource pressure, not network flakiness, since there IS no network call. */
const qrActivities = proxyActivities<MerchantActivities>({
  startToCloseTimeout: '3 seconds',
  retry: {
    initialInterval: '200ms',
    backoffCoefficient: 2,
    maximumInterval: '1 second',
    maximumAttempts: 2,
    nonRetryableErrorTypes: ['VALIDATION_ERROR'],
  },
});

/**
 * POS webhook delivery — the "moderate-risk, standard exponential backoff"
 * profile requirement #4 asks for explicitly. Generous enough to genuinely
 * outlast a temporarily-unavailable POS terminal (the requirement's own
 * framing), capped so a permanently-dead endpoint doesn't retry forever.
 */
const webhookActivities = proxyActivities<MerchantActivities>({
  startToCloseTimeout: '8 seconds', // matches the old node's own configured HTTP timeout
  retry: {
    initialInterval: '1 second',
    backoffCoefficient: 2,
    maximumInterval: '30 seconds',
    maximumAttempts: 6,
    nonRetryableErrorTypes: ['CONFIGURATION_ERROR'],
  },
});

const notificationActivities = proxyActivities<MerchantActivities>({
  startToCloseTimeout: '5 seconds',
  retry: {
    initialInterval: '500ms',
    backoffCoefficient: 2,
    maximumInterval: '5 seconds',
    maximumAttempts: 3,
  },
});

const { verifyMerchantAndAmount } = verificationActivities;
const { generateCheckoutQr } = qrActivities;
const { buildAndSignPosNotification, firePosWebhook } = webhookActivities;
const { notifyCustomerPaymentConfirmed } = notificationActivities;

// ---------------------------------------------------------------------------
// Signal & Query
// ---------------------------------------------------------------------------

/**
 * NOT present in the source export — added because nothing in the old
 * file's node sequence represents the customer actually scanning and
 * paying; Block 9.8 simply assumes success unconditionally. See the
 * conversational note above this code for the full reasoning.
 */
export interface ConfirmPaymentSignalPayload {
  readonly confirmedAmountUzs: number;
}

export const confirmPaymentSignal = defineSignal<[ConfirmPaymentSignalPayload]>('confirmPayment');

export type MerchantWorkflowStatusSnapshot =
  | { phase: 'AWAITING_SCAN' }
  | { phase: 'NOTIFYING' }
  | { phase: 'COMPLETE'; result: MerchantCheckoutWorkflowResult };

export const getMerchantStatusQuery = defineQuery<MerchantWorkflowStatusSnapshot>('getStatus');

/**
 * 10-minute QR validity window — deliberately short relative to this
 * platform's other async waits (P2P's 15 minutes, Credit's 24 hours),
 * because this is a customer physically standing at a checkout counter,
 * not a remote approval with no time pressure.
 */
const PAYMENT_WAIT_TIMEOUT = '10 minutes';

export async function MerchantCheckoutWorkflow(
  input: MerchantCheckoutWorkflowInput,
): Promise<MerchantCheckoutWorkflowResult> {
  const workflowId = workflowInfo().workflowId;

  let confirmationPayload: ConfirmPaymentSignalPayload | null = null;
  let statusSnapshot: MerchantWorkflowStatusSnapshot = { phase: 'AWAITING_SCAN' };

  setHandler(confirmPaymentSignal, (payload) => {
    confirmationPayload = payload;
  });
  setHandler(getMerchantStatusQuery, () => statusSnapshot);

  // Step 1 — Verify merchant + amount.
  const verification = await verifyMerchantAndAmount({
    merchantAlias: input.merchantAlias,
    rawTicketText: input.rawTicketText,
    amountUzs: input.amountUzs,
  });

  switch (verification.outcome) {
    case 'INVALID': {
      const result: MerchantCheckoutWorkflowResult = {
        status: 'VALIDATION_FAILED',
        traceId: input.traceId,
        reason: verification.reason,
      };
      statusSnapshot = { phase: 'COMPLETE', result };
      return result;
    }
    case 'VERIFIED':
      break; // proceeds below
    default:
      assertVerificationUnreachable(verification);
  }

  const { record, amountUzs } = verification;

  // Step 2 — Generate the checkout QR. Self-hosted, no external call.
  await generateCheckoutQr({ merchantId: record.canonicalId, amountUzs, traceId: input.traceId });

  // Step 3 — Wait for the payment-confirmation signal (or time out).
  const settled = await condition(() => confirmationPayload !== null, PAYMENT_WAIT_TIMEOUT);

  if (!settled || confirmationPayload === null) {
    const result: MerchantCheckoutWorkflowResult = { status: 'PAYMENT_TIMED_OUT', traceId: input.traceId };
    statusSnapshot = { phase: 'COMPLETE', result };
    return result;
  }

  statusSnapshot = { phase: 'NOTIFYING' };

  // Fix: Type assertion to prevent TS 'never' inference from closure mutation
  const confirmedPayload = confirmationPayload as ConfirmPaymentSignalPayload;

  // Step 4 — Build + sign the POS notification, then fire it. A webhook
  // delivery failure here, even after Temporal's 6-attempt retry policy
  // exhausts, does NOT fail the overall checkout — see types.ts's
  // posNotificationDelivered comment for why.
  let posNotificationDelivered = true;
  try {
    const notification = await buildAndSignPosNotification({
      canonicalMerchantId: record.canonicalId,
      traceId: input.traceId,
      amountUzs: confirmedPayload.confirmedAmountUzs,
    });
    await firePosWebhook(notification);
  } catch {
    posNotificationDelivered = false;
  }

  // Step 5 — Notify the customer. This DOES reflect their real, confirmed
  // payment, regardless of whether the merchant's POS terminal heard about
  // it successfully.
  await notifyCustomerPaymentConfirmed({
    telegramChatId: input.customerId,
    traceId: input.traceId,
    amountUzs: confirmedPayload.confirmedAmountUzs,
  });

  const result: MerchantCheckoutWorkflowResult = {
    status: 'SUCCESS',
    traceId: input.traceId,
    merchantId: record.canonicalId,
    confirmedAmountUzs: confirmedPayload.confirmedAmountUzs,
    posNotificationDelivered,
  };
  statusSnapshot = { phase: 'COMPLETE', result };
  return result;
}

export function describeOutcome(result: MerchantCheckoutWorkflowResult): string {
  switch (result.status) {
    case 'VALIDATION_FAILED':
      return `Validation failed: ${result.reason}`;
    case 'PAYMENT_TIMED_OUT':
      return 'No payment confirmation received within the QR validity window.';
    case 'SUCCESS':
      return `Checkout confirmed for merchant ${result.merchantId}, ${result.confirmedAmountUzs} UZS (POS notified: ${result.posNotificationDelivered}).`;
    default:
      return assertUnreachable(result);
  }
}