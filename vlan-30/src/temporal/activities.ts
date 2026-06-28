// src/temporal/activities.ts
//
// Dependency-injection pattern, consistent with P2P's createP2PActivities:
// this module exports a factory, never a module-scope singleton, so the
// same activities object can be constructed against real infrastructure
// (worker.ts, not yet written) or fully-mocked dependencies (tests, not
// yet written) with identical code.

import { ApplicationFailure } from '@temporalio/activity';
import type {
  BillPayActivityDependencies,
  ProviderRegistryRecord,
  BillPayHttpRequest,
} from '../types.js';

// ---------------------------------------------------------------------------
// Idempotency key generation — ported EXACTLY from the old node's
// generatePureJSHash, byte-for-byte, including the specific FNV-1a constants.
//
// Why this lives in an Activity despite being a pure, deterministic
// computation with zero I/O: same reasoning this project already
// established for P2P's sanitizeRecipientName. Workflow code is
// replay-determinism-constrained — in-flight workflow histories must
// replay identically against whatever Workflow code version is deployed.
// Activity code carries no such constraint. If this hash algorithm ever
// needs to change (a collision concern, a format change), putting it here
// means that change ships same-day with zero concern for in-flight
// workflow replay compatibility — exactly the same argument, applied
// consistently rather than abandoned the moment the computation happens
// to be "simple."
// ---------------------------------------------------------------------------

function fnv1aHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

export interface IdempotencyKeyInput {
  readonly providerCode: string;
  readonly traceId: string;
  readonly identifier: string;
  readonly amountUzs: number;
}

/**
 * Outcome of the actual provider call, BEFORE workflow-level interpretation.
 * Modeled as a discriminated result rather than a thrown exception for the
 * business-outcome cases — see the dedicated note in executeProviderPayment
 * below for why a provider saying "REJECTED" inside a 200 OK is fundamentally
 * different from the HTTP call itself failing.
 */
export type ProviderCallOutcome = {
  readonly kind: 'BUSINESS_OUTCOME';
  readonly status: 'SUCCESS' | 'FAILED' | 'PENDING';
  readonly providerTransactionId: string;
  readonly confirmedAmountUzs: number
};

export interface BillPayActivities {
  lookupProvider(tenantId: string, providerCode: string): Promise<ProviderRegistryRecord>;
  generateIdempotencyKey(input: IdempotencyKeyInput): Promise<string>;
  fetchProviderSecret(vaultSecretPath: string): Promise<string>;
  executeProviderPayment(input: {
    registryRecord: ProviderRegistryRecord;
    secret: string;
    identifier: string;
    amountUzs: number;
    traceId: string;
    idempotencyKey: string;
  }): Promise<ProviderCallOutcome>;
}

function getValueByPath(obj: unknown, path: string): unknown {
  // Path traversal is legitimate HERE — see the conversational note on why
  // the request-building side dropped this but response-parsing keeps it:
  // third-party response shapes are not ours to flatten.
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc !== null && typeof acc === 'object' && key in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

export function createBillPayActivities(deps: BillPayActivityDependencies): BillPayActivities {
  return {
    async lookupProvider(tenantId, providerCode): Promise<ProviderRegistryRecord> {
      const record = await deps.providerRegistryStore.getActiveProvider(tenantId, providerCode);
      if (!record) {
        // Definitive — no retry will make a provider that doesn't exist
        // (or is deactivated) start existing. Direct successor to the old
        // node's BLOCKED_UNKNOWN_PROVIDER branch.
        throw ApplicationFailure.create({
          message: `No active provider registry entry for tenant=${tenantId}, provider=${providerCode}.`,
          type: 'UNKNOWN_PROVIDER',
          nonRetryable: true,
        });
      }
      return record;
    },

    async generateIdempotencyKey(input): Promise<string> {
      const seed = [input.providerCode, input.traceId, input.identifier, input.amountUzs].join('|');
      return `bp_${fnv1aHash(seed)}`;
    },

    async fetchProviderSecret(vaultSecretPath): Promise<string> {
      try {
        return await deps.secretsManager.fetchSecret(vaultSecretPath);
      } catch (err) {
        // Distinguishing "Vault is transiently unreachable" (retryable)
        // from "this path genuinely doesn't exist in Vault" (a
        // configuration error in the registry row, not something a retry
        // fixes) — same defensive-check-since-the-real-implementation-
        // doesn't-exist-yet pattern used for cbuClient's error code in P2P.
        const code = (err as { code?: string } | undefined)?.code;
        if (code === 'SECRET_NOT_FOUND') {
          throw ApplicationFailure.create({
            message: `Vault secret not found at path: ${vaultSecretPath}. This indicates a misconfigured provider_registry row, not a transient failure.`,
            type: 'CONFIGURATION_ERROR',
            nonRetryable: true,
          });
        }
        throw ApplicationFailure.create({
          message: err instanceof Error ? err.message : 'Vault secret fetch failed.',
          type: 'PROVIDER_UNAVAILABLE',
          nonRetryable: false,
        });
      }
    },

    async executeProviderPayment(input): Promise<ProviderCallOutcome> {
      const { registryRecord, secret } = input;

      const headerValue =
        registryRecord.authMethod === 'BEARER_TOKEN' ? `Bearer ${secret}` : secret;

      const body: Record<string, unknown> = {};
      for (const mapping of registryRecord.fieldMapping) {
        const valueBySourceField: Record<string, unknown> = {
          identifier: input.identifier,
          amountUzs: input.amountUzs,
          traceId: input.traceId,
          idempotencyKey: input.idempotencyKey,
        };
        body[mapping.targetField] = valueBySourceField[mapping.sourceField];
      }

      const request: BillPayHttpRequest = {
        method: registryRecord.httpMethod,
        url: registryRecord.endpointUrl,
        headers: {
          [registryRecord.authHeaderName]: headerValue,
          'Content-Type': 'application/json',
        },
        body,
        timeoutMs: registryRecord.timeoutMs,
      };

      let response;
      try {
        response = await deps.httpClient.send(request);
      } catch (err) {
        // THIS is a genuine transport failure — connection refused, DNS
        // failure, the HTTP client's own timeout firing. This throws, and
        // Temporal's retry policy (configured in workflows.ts) is what
        // decides whether to try again.
        throw ApplicationFailure.create({
          message: err instanceof Error ? err.message : 'HTTP request failed.',
          type: 'TRANSPORT_FAILURE',
          nonRetryable: false, // This guarantees Temporal will retry it!
        });
      }

      // Critical behavioral fidelity point: the old node set
      // `neverError: true` specifically so a non-2xx HTTP status did NOT
      // throw — the response BODY's own status field is what determines
      // business outcome, regardless of HTTP status code. A provider
      // returning HTTP 400 with a body saying `{"state": "REJECTED"}` is
      // a normal, successfully-completed Activity call that resolved to a
      // FAILED business outcome — not a thrown exception, and NOT
      // something Temporal's retry policy should ever see or retry,
      // because retrying a definitive rejection changes nothing.
      const rawBody = response.body;
      const rawStatus = getValueByPath(rawBody, registryRecord.responseMapping.fieldMapping.statusPath);
      const mappedStatus =
        typeof rawStatus === 'string'
          ? registryRecord.responseMapping.statusMap[rawStatus] ?? 'FAILED' // an unrecognized status string is treated as FAILED, not silently passed through — see types.ts's ResponseMappingSchema comment
          : 'FAILED';

      const providerTransactionId = getValueByPath(
        rawBody,
        registryRecord.responseMapping.fieldMapping.transactionIdPath,
      );
      const confirmedAmount = getValueByPath(rawBody, registryRecord.responseMapping.fieldMapping.amountPath);

      return {
        kind: 'BUSINESS_OUTCOME',
        status: mappedStatus,
        providerTransactionId: typeof providerTransactionId === 'string' ? providerTransactionId : '',
        confirmedAmountUzs: typeof confirmedAmount === 'number' ? confirmedAmount : input.amountUzs,
      };
    },
  };
}