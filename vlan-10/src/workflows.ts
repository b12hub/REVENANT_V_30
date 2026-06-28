import {
  proxyActivities,
  defineSignal,
  defineQuery,
  setHandler,
  condition,
  workflowInfo,
  ApplicationFailure,
} from '@temporalio/workflow';
import type { P2PActivities } from './activities';
import type {
  P2PTransferWorkflowInput,
  P2PTransferWorkflowResult,
} from './types';
import { assertUnreachable } from './types';

const standardActivities = proxyActivities<P2PActivities>({
  startToCloseTimeout: '5 seconds',
  retry: {
    initialInterval: '500ms',
    backoffCoefficient: 2,
    maximumInterval: '5 seconds',
    maximumAttempts: 4,
  },
});

const cbuResolutionActivities = proxyActivities<P2PActivities>({
  startToCloseTimeout: '8 seconds',
  retry: {
    initialInterval: '500ms',
    backoffCoefficient: 2,
    maximumInterval: '5 seconds',
    maximumAttempts: 4,
    nonRetryableErrorTypes: ['PHONE_NOT_REGISTERED'],
  },
});

const executionActivities = proxyActivities<P2PActivities>({
  startToCloseTimeout: '15 seconds',
  retry: {
    initialInterval: '1 second',
    backoffCoefficient: 1, 
    maximumAttempts: 2,
    nonRetryableErrorTypes: ['LEDGER_FAILURE'],
  },
});

const {
  resolveCbuPhoneToAccount,
} = cbuResolutionActivities;

const {
  sanitizeRecipientName,
  dispatchConfirmationPrompt,
  verifyConfirmationCallback,
  checkIdempotency,
} = standardActivities;

const { executeTransfer } = executionActivities;

export interface ConfirmP2PSignalPayload {
  readonly rawToken: string;
}

export interface CancelP2PSignalPayload {
  readonly reason: string;
}

export const confirmP2PSignal = defineSignal<[ConfirmP2PSignalPayload]>('confirmP2P');
export const cancelP2PSignal = defineSignal<[CancelP2PSignalPayload]>('cancelP2P');

export type P2PWorkflowStatusSnapshot =
  | { phase: 'AWAITING_CONFIRMATION' }
  | { phase: 'PROCESSING' }
  | { phase: 'COMPLETE'; result: P2PTransferWorkflowResult };

export const getP2PStatusQuery = defineQuery<P2PWorkflowStatusSnapshot>('getStatus');

const CONFIRMATION_WAIT_TIMEOUT = '15 minutes'; 

export async function P2PTransferWorkflow(
  input: P2PTransferWorkflowInput,
): Promise<P2PTransferWorkflowResult> {
  const workflowId = workflowInfo().workflowId;

  let cancelSignal: { reason: string } | null = null;
  let confirmationSignal: { rawToken: string } | null = null;
  let statusSnapshot: P2PWorkflowStatusSnapshot = { phase: 'AWAITING_CONFIRMATION' };

  setHandler(confirmP2PSignal, (payload) => {
    confirmationSignal = payload;
  });
  setHandler(cancelP2PSignal, (payload) => {
    cancelSignal = payload;
  });
  setHandler(getP2PStatusQuery, () => statusSnapshot);

  let resolution;
  try {
    resolution = await resolveCbuPhoneToAccount(input.phone);
  } catch (err) {
    const result: P2PTransferWorkflowResult = {
      status: 'RECIPIENT_RESOLUTION_FAILED',
      traceId: input.traceId,
      errorDetail: err instanceof ApplicationFailure ? err.message : 'Recipient resolution failed.',
    };
    statusSnapshot = { phase: 'COMPLETE', result };
    return result;
  }

  const sanitizedName = await sanitizeRecipientName(resolution.accountHolderName);

  const { signedCallbackData } = await dispatchConfirmationPrompt({
    workflowId,
    telegramChatId: input.customerId, 
    phone: input.phone,
    amountUzs: input.amountUzs,
    sanitizedRecipientName: sanitizedName,
  });
  void signedCallbackData; 

  const settledInTime = await condition(
    () => confirmationSignal !== null || cancelSignal !== null,
    CONFIRMATION_WAIT_TIMEOUT,
  );

  if (cancelSignal !== null) {
    const result: P2PTransferWorkflowResult = {
      status: 'DECLINED',
      traceId: input.traceId,
      reason: (cancelSignal as { reason: string }).reason,
    };
    statusSnapshot = { phase: 'COMPLETE', result };
    return result;
  }

  if (!settledInTime || confirmationSignal === null) {
    const result: P2PTransferWorkflowResult = { status: 'TIMED_OUT', traceId: input.traceId };
    statusSnapshot = { phase: 'COMPLETE', result };
    return result;
  }

  statusSnapshot = { phase: 'PROCESSING' };

  try {
    await verifyConfirmationCallback((confirmationSignal as { rawToken: string }).rawToken, workflowId);
  } catch (err) {
    const result: P2PTransferWorkflowResult = {
      status: 'CALLBACK_VERIFICATION_FAILED',
      traceId: input.traceId,
      errorDetail: err instanceof ApplicationFailure ? err.message : 'Callback verification failed.',
    };
    statusSnapshot = { phase: 'COMPLETE', result };
    return result;
  }

  const idempotencyResult = await checkIdempotency(input.idempotencyKey);
  if (idempotencyResult.isDuplicate) {
    const result: P2PTransferWorkflowResult = {
      status: 'IDEMPOTENCY_DUPLICATE',
      traceId: input.traceId,
      existingTransactionId: idempotencyResult.existingTransactionId ?? 'UNKNOWN',
    };
    statusSnapshot = { phase: 'COMPLETE', result };
    return result;
  }

  try {
    const execution = await executeTransfer({
      idempotencyKey: input.idempotencyKey,
      senderCustomerId: input.customerId,
      recipientMaskedAccount: resolution.maskedAccountNumber,
      amountUzs: input.amountUzs,
    });

    const result: P2PTransferWorkflowResult = {
      status: 'SUCCESS',
      traceId: input.traceId,
      transactionId: execution.transactionId,
      recipientAccountMasked: resolution.maskedAccountNumber,
      providerReference: execution.providerReference,
    };
    statusSnapshot = { phase: 'COMPLETE', result };
    return result;
  } catch (err) {
    const result: P2PTransferWorkflowResult = {
      status: 'EXECUTION_FAILED',
      traceId: input.traceId,
      errorDetail: err instanceof ApplicationFailure ? err.message : 'Transfer execution failed.',
    };
    statusSnapshot = { phase: 'COMPLETE', result };
    return result;
  }
}

export function describeOutcome(result: P2PTransferWorkflowResult): string {
  switch (result.status) {
    case 'SUCCESS':
      return `Transfer ${result.transactionId} succeeded.`;
    case 'DECLINED':
      return `Customer declined: ${result.reason}`;
    case 'TIMED_OUT':
      return 'No confirmation received within the TTL window.';
    case 'CALLBACK_VERIFICATION_FAILED':
      return `Callback verification failed: ${result.errorDetail}`;
    case 'IDEMPOTENCY_DUPLICATE':
      return `Duplicate of already-completed transaction ${result.existingTransactionId}.`;
    case 'RECIPIENT_RESOLUTION_FAILED':
      return `Recipient resolution failed: ${result.errorDetail}`;
    case 'EXECUTION_FAILED':
      return `Execution failed: ${result.errorDetail}`;
    default:
      return assertUnreachable(result);
  }
}
