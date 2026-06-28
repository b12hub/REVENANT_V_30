// src/temporal/workflows.ts

import { proxyActivities, ApplicationFailure } from '@temporalio/workflow';
import type { BillPayActivities } from './activities';
import type { BillPayWorkflowInput, BillPayWorkflowResult } from '../types';
import { assertUnreachable } from '../types';

// ---------------------------------------------------------------------------
// Retry policies — three distinct profiles, deliberately NOT a shared
// default, for three genuinely different risk/reliability profiles.
// ---------------------------------------------------------------------------

/** Fast, low-risk operations: registry lookup, idempotency key generation. */
const fastActivities = proxyActivities<BillPayActivities>({
  startToCloseTimeout: '3 seconds',
  retry: {
    initialInterval: '250ms',
    backoffCoefficient: 2,
    maximumInterval: '2 seconds',
    maximumAttempts: 3,
    nonRetryableErrorTypes: ['UNKNOWN_PROVIDER'],
  },
});

/** Vault: moderate timeout, moderate retry — a real but usually-reliable internal dependency. */
const vaultActivities = proxyActivities<BillPayActivities>({
  startToCloseTimeout: '5 seconds',
  retry: {
    initialInterval: '500ms',
    backoffCoefficient: 2,
    maximumInterval: '5 seconds',
    maximumAttempts: 4,
    nonRetryableErrorTypes: ['CONFIGURATION_ERROR'],
  },
});

/**
 * The provider-call profile — deliberately the MOST liberal retry policy
 * in this codebase, a direct contrast to P2P's deliberately conservative
 * disbursement policy (max 2 attempts, no real backoff). That contrast is
 * not an inconsistency: P2P's execution risk is double-disbursement on
 * retry; this Activity's risk is the opposite direction — under-retrying
 * against a "historically flaky" (your own framing) third-party utility
 * API that the idempotency key sent to the provider is specifically there
 * to make safe to retry against. Different risk shape, deliberately
 * different policy.
 *
 * Timeout kept at int(10000ms) — matching the old node's own configured
 * value exactly, not adjusted, since nothing about this rebuild changes
 * how long it's reasonable to wait for these specific providers.
 */
const providerCallActivities = proxyActivities<BillPayActivities>({
  startToCloseTimeout: '10 seconds',
  retry: {
    initialInterval: '1 second',
    backoffCoefficient: 2,
    maximumInterval: '30 seconds',
    maximumAttempts: 5,
  },
});

const { lookupProvider, generateIdempotencyKey } = fastActivities;
const { fetchProviderSecret } = vaultActivities;
const { executeProviderPayment } = providerCallActivities;

export async function BillPayWorkflow(input: BillPayWorkflowInput): Promise<BillPayWorkflowResult> {
  // Step 1 — Registry lookup. A miss here is definitive; nothing past this
  // point can run without knowing how to talk to the provider.
  let registryRecord;
  try {
    registryRecord = await lookupProvider(input.tenantId, input.providerCode);
  } catch (err) {
    return {
      status: 'UNKNOWN_PROVIDER',
      traceId: input.traceId,
      idempotencyKey: '', // never generated — there was no provider to scope it to
    };
  }

  // Step 2 — Idempotency key. Always generated, regardless of what happens
  // next, so every returned result (including failure paths below) carries
  // a real key — useful for support/ops correlation even on a failed attempt.
  const idempotencyKey = await generateIdempotencyKey({
    providerCode: input.providerCode,
    traceId: input.traceId,
    identifier: input.identifier,
    amountUzs: input.amountUzs,
  });

  // Step 3 — Vault secret fetch.
  let secret: string;
  try {
    secret = await fetchProviderSecret(registryRecord.vaultSecretPath);
  } catch (err) {
    const errorType = err instanceof ApplicationFailure ? err.type : undefined;
    if (errorType === 'CONFIGURATION_ERROR') {
      return {
        status: 'CONFIGURATION_ERROR',
        traceId: input.traceId,
        idempotencyKey,
        errorDetail: err instanceof ApplicationFailure ? err.message : 'Vault configuration error.',
      };
    }
    return {
      status: 'PROVIDER_UNAVAILABLE',
      traceId: input.traceId,
      idempotencyKey,
      errorDetail: err instanceof ApplicationFailure ? err.message : 'Vault unavailable.',
    };
  }

  // Step 4 — The actual provider call. See activities.ts for why this
  // returns a discriminated result rather than throwing for business-level
  // outcomes — only a genuine transport failure that exhausted the
  // 5-attempt retry policy above reaches this workflow as a thrown error.
  let outcome;
  try {
    outcome = await executeProviderPayment({
      registryRecord,
      secret,
      identifier: input.identifier,
      amountUzs: input.amountUzs,
      traceId: input.traceId,
      idempotencyKey,
    });
  } catch (err) {
    return {
      status: 'PROVIDER_UNAVAILABLE',
      traceId: input.traceId,
      idempotencyKey,
      errorDetail: err instanceof ApplicationFailure ? err.message : 'Provider call failed after exhausting retries.',
    };
  }

  // Business outcome from here on — mirrors the old node's three-way
  // status_map result exactly (SUCCESS / FAILED / PENDING).
  switch (outcome.status) {
    case 'SUCCESS':
      return {
        status: 'SUCCESS',
        traceId: input.traceId,
        idempotencyKey,
        providerTransactionId: outcome.providerTransactionId,
        confirmedAmountUzs: outcome.confirmedAmountUzs,
      };
    case 'FAILED':
      return {
        status: 'FAILED',
        traceId: input.traceId,
        idempotencyKey,
        errorDetail: `Provider returned a definitive failure (provider_transaction_id=${outcome.providerTransactionId || 'none'}).`,
      };
    case 'PENDING':
      // Terminal here, faithfully matching the old flow — which had no
      // node after Universal Response Mapper to poll a PENDING payment
      // through to settlement either. A future enhancement (a
      // short-lived child workflow polling for final settlement) is a
      // reasonable next step, but it's new scope, not something this
      // port silently dropped from the original.
      return {
        status: 'PENDING',
        traceId: input.traceId,
        idempotencyKey,
        providerTransactionId: outcome.providerTransactionId,
      };
    default:
      return assertUnreachable(outcome.status);
  }
}