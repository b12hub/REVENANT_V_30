// AFTER
/**
 * ivr-workflow.ts
 *
 * Temporal Workflow for IVR Business Orchestration.
 * This workflow handles only durable, transactional milestones.
 */

import {
  proxyActivities,
  defineSignal,
  setHandler,
  defineQuery,
  condition,
} from '@temporalio/workflow';
import type { Activities } from './activities.js';
import type { TransactionRequest, TransactionResult } from './ivr-types.js';

// ---------------------------------------------------------------------------
// Activity proxy
// ---------------------------------------------------------------------------

const { authorizeAndExecuteTransaction } = proxyActivities<Activities>({
  startToCloseTimeout: '15 seconds',
  retry: {
    initialInterval: '2 seconds',
    maximumAttempts: 1,          // no retries for financial auth
  },
});

// ---------------------------------------------------------------------------
// Signals and Queries
// ---------------------------------------------------------------------------

export const executeTransactionSignal = defineSignal<[TransactionRequest]>('executeTransaction');
export const transactionAuthorizationQuery = defineQuery<TransactionResult | null>('transactionAuthorization');
export const endCallSignal = defineSignal('endCall');

// ---------------------------------------------------------------------------
// Workflow Implementation
// ---------------------------------------------------------------------------

export async function IvrBusinessOrchestrationWorkflow(
  sessionId: string
): Promise<void> {
  console.log(`[IVR Workflow] Started for session ${sessionId}`);

  // Durable state
  let callEnded = false;
  let latestResult: TransactionResult | null = null;
  const pendingRequests: TransactionRequest[] = []; // Queue for incoming signals

  // 1. SYNC Signal Handlers (Never use async here)
  setHandler(executeTransactionSignal, (request: TransactionRequest) => {
    pendingRequests.push(request);
  });

  setHandler(transactionAuthorizationQuery, () => latestResult);

  setHandler(endCallSignal, () => {
    callEnded = true;
  });

  // 2. Main Workflow Loop (Where async operations are safely tracked)
  while (!callEnded) {
    // Wait until there's a request to process OR the call ends
    await condition(() => pendingRequests.length > 0 || callEnded);

    if (pendingRequests.length > 0) {
      // Dequeue the next transaction request
      const request = pendingRequests.shift()!;
      console.log(`[IVR Workflow] Executing transaction: ${request.intent.intentName}`);

      try {
        const activityResult = await authorizeAndExecuteTransaction(
          sessionId,
          request.intent,
          request.identity
        );

        latestResult = {
          success: activityResult.success,
          ttsMessageToPlay: activityResult.success
            ? "To'lov muvaffaqiyatli amalga oshirildi. (Payment successful.)"
            : `To'lov rad etildi: ${activityResult.errorReason || 'Noma\'lum xato'}`
        };
      } catch (err) {
        console.error('[IVR Workflow] Transaction activity failed:', err);
        latestResult = {
          success: false,
          ttsMessageToPlay: "Kechirasiz, xatolik yuz berdi. Iltimos qayta urinib ko'ring. (Sorry, an error occurred.)",
        };
      }
    }
  }

  console.log('[IVR Workflow] Call ended – workflow completing');
}