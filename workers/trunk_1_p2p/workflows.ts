// workflows.ts — Trunk 1: P2P Execution & Compliance
//
// NAMING COLLISION FLAG: this exports a function literally named
// `P2PTransferWorkflow`, per this task's explicit instruction — but a
// DIFFERENT, earlier-built workflow in this same codebase (VLAN 10's
// workflows.ts) already uses that exact name, and includes logic this
// file deliberately does NOT (CBU phone-to-account resolution, the
// CONFIRM_P2P signal-wait). If both are ever registered in the same
// Temporal namespace/worker, this is a real registration conflict, not a
// cosmetic one. This file's actual scope is narrower and BYOC-specific —
// sanitize -> compliance -> ledger only — consistent with this task's
// explicit four-step business logic. Resolve the collision before both
// ship together: rename one (e.g. this file's export to
// `P2PComplianceTrunkWorkflow`), or have VLAN 10's confirmation flow
// invoke THIS workflow as a child workflow post-confirmation rather than
// each independently claiming the same exported name. Implemented here
// exactly as instructed; flagged so it isn't a silent landmine.

import { proxyActivities, ApplicationFailure, workflowInfo } from '@temporalio/workflow';
import type {
  LocalP2PActivities,
  PlatformComplianceActivities,
  TransactionAmountBand,
} from './activities';

// ---------------------------------------------------------------------------
// THREE proxyActivities blocks, TWO task queues. See the conversational
// note above this code for why: "two blocks" (the literal instruction)
// describes queue TOPOLOGY — local vs. remote — which this honors
// exactly. It does not describe retry-policy GRANULARITY, and collapsing
// the sanitizer (fast, no I/O, detection-is-detection-no-retry-value) and
// the ledger transfer (financial execution, deserves its own conservative
// cap) into one shared policy would contradict the established,
// justified principle from every prior money-moving activity in this
// build (P2P's executeTransfer, Credit's executeDisbursement — same
// maximumAttempts: 2 reused here for consistency, not reinvented).
// ---------------------------------------------------------------------------

/** Fast, local, BYOC-resident. Sanitizer detection is deterministic — retrying an unchanged threat-bearing payload finds the exact same threat every time, hence the nonRetryable type. Fraud-token computation is pure keyed-hash work, no network — retried purely for worker-crash resilience, not network flakiness. */
const fastLocalActivities = proxyActivities<LocalP2PActivities>({
  taskQueue: 'p2p-queue', // explicit, not relying on the SDK's "defaults to the workflow's own queue" behavior — this IS the compliance-critical boundary of the whole exercise; an implicit default silently changing on a future refactor is exactly the kind of thing that shouldn't be left to inference here.
  startToCloseTimeout: '2 seconds',
  retry: {
    initialInterval: '200ms',
    backoffCoefficient: 2,
    maximumInterval: '2 seconds',
    maximumAttempts: 3,
    nonRetryableErrorTypes: ['CRITICAL_THREAT_DETECTED'],
  },
});

/** The conservative, financial-execution profile — deliberately matching the exact numbers established for P2P's executeTransfer and Credit's executeDisbursement, for cross-codebase consistency on the single highest-stakes operation in this workflow. */
const ledgerExecutionActivities = proxyActivities<LocalP2PActivities>({
  taskQueue: 'p2p-queue',
  startToCloseTimeout: '15 seconds',
  retry: {
    initialInterval: '1 second',
    backoffCoefficient: 1,
    maximumAttempts: 2,
    nonRetryableErrorTypes: ['LEDGER_FAILURE'],
  },
});

/**
 * The remote, cross-perimeter profile. Generous by explicit instruction —
 * absorbing upstream network/vendor latency to the SaaS Edge without
 * failing the durable workflow. Both AML/PEP and the Fraud Network share
 * this profile: both are external-to-this-perimeter calls with similar
 * latency-variance risk, and there's no basis in this task's scope to
 * differentiate them further.
 */
const platformActivities = proxyActivities<PlatformComplianceActivities>({
  taskQueue: 'platform-queue', // EXPLICIT routing — this single line is the actual primary security control that keeps these two calls off any BYOC-resident worker, regardless of which workers happen to be running. See worker.ts for why worker-side registration omission is the secondary, defense-in-depth layer, not the primary one.
  startToCloseTimeout: '20 seconds',
  retry: {
    initialInterval: '2 seconds',
    backoffCoefficient: 2,
    maximumInterval: '90 seconds', // generous — lets a transient vendor-side or cross-region network blip clear without exhausting the policy
    maximumAttempts: 8,
  },
});

const { runTitaniumSanitizer, computeFraudVectorToken } = fastLocalActivities;
const { executeLedgerTransfer } = ledgerExecutionActivities;
const { runAmlPepScreening, verifyFraudVector } = platformActivities;

// ---------------------------------------------------------------------------
// Workflow input / result
// ---------------------------------------------------------------------------

export interface P2PComplianceWorkflowInput {
  readonly traceId: string;
  readonly tenantId: string;
  readonly idempotencyKey: string;
  readonly rawPayloadText: string;
  readonly senderFullName: string;
  readonly recipientFullName: string;
  readonly senderAccountRef: string;
  readonly recipientAccountRef: string;
  readonly amountUzs: string; // Propagated string type to prevent floating-point loss
  // RAW PII — present in this WORKFLOW's input deliberately, because it
  // must reach computeFraudVectorToken somehow. This means this
  // workflow's OWN execution history (which Temporal persists,
  // including its start-event input) carries this data too — see the
  // data-localization caveat in worker.ts. The same mitigation
  // (per-tenant co-located namespace, or a Payload Codec) that protects
  // the ledger fields below protects these fields equally; it's one
  // unresolved gap, not two unrelated ones.
  readonly deviceFingerprint: string;
  readonly ipAddress: string;
  readonly sessionId: string;
}

interface OutcomeBase {
  readonly traceId: string;
}

export interface SanitizerRejected extends OutcomeBase {
  readonly status: 'SANITIZER_REJECTED';
  readonly reason: string;
}

export interface AmlPepRejected extends OutcomeBase {
  readonly status: 'AML_PEP_REJECTED';
  readonly matchedRole: string;
  readonly listSource: string;
}

export interface FraudNetworkRejected extends OutcomeBase {
  readonly status: 'FRAUD_NETWORK_REJECTED';
  readonly networkRiskScore: number;
}

export interface LedgerExecutionFailed extends OutcomeBase {
  readonly status: 'LEDGER_EXECUTION_FAILED';
  readonly reason: string;
}

export interface ComplianceSuccess extends OutcomeBase {
  readonly status: 'SUCCESS';
  readonly transactionId: string;
  readonly ledgerSequenceNumber: string;
}

export type P2PComplianceWorkflowResult =
  | SanitizerRejected
  | AmlPepRejected
  | FraudNetworkRejected
  | LedgerExecutionFailed
  | ComplianceSuccess;

export function assertUnreachable(value: never): never {
  throw new Error(`Unreachable P2P compliance workflow result: ${JSON.stringify(value)}`);
}

function resolveAmountBand(amountUzsStr: string): TransactionAmountBand {
  const amountUzs = Number(amountUzsStr); // Safe to cast for coarse banding; ledger gets the exact string
  if (amountUzs < 100_000) return 'UNDER_100K';
  if (amountUzs < 1_000_000) return 'BETWEEN_100K_AND_1M';
  if (amountUzs < 10_000_000) return 'BETWEEN_1M_AND_10M';
  return 'OVER_10M';
}

// ---------------------------------------------------------------------------
// Workflow
//
// TRUST BOUNDARY SUMMARY, stated once, in full, here:
//   - This workflow's ORCHESTRATION ITSELF (this function — sequencing,
//     branching, the decision of whether to call the ledger at all) runs
//     wherever its task queue routes the workflow task: p2p-queue, inside
//     BYOC. The SaaS Edge never independently decides whether a transfer
//     executes — it can only render an opinion (CLEAR/MATCH_FOUND,
//     CLEAN/FLAGGED) that this BYOC-resident code chooses how to act on.
//     Money movement authority never leaves the bank's perimeter.
//   - Raw PII (deviceFingerprint, ipAddress, sessionId) is read by exactly
//     ONE activity (computeFraudVectorToken), which is pinned to
//     p2p-queue. Every subsequent step — including both remote calls —
//     only ever sees the already-hashed FraudVectorPayload.
// ---------------------------------------------------------------------------

export async function P2PComplianceTrunkWorkflow(
  input: P2PComplianceWorkflowInput,
): Promise<P2PComplianceWorkflowResult> {
  // Step 1 — Restore canonical trace_id. Deterministic, no crypto: falls
  // back to workflowInfo().workflowId (a Temporal SDK call that is itself
  // replay-safe and deterministic — fixed metadata at workflow start, not
  // derived from wall-clock or randomness) rather than attempting to
  // generate a fresh ID, which would require node:crypto and violate the
  // explicit determinism constraint. Real-world malformed input should
  // already be rejected upstream by the gRPC ingress's Zod schema,
  // consistent with every other VLAN in this build — this is a defensive
  // fallback, not the primary validation layer.
  const canonicalTraceId = input.traceId.length > 0 ? input.traceId : workflowInfo().workflowId;

  // Step 2 — Titanium Sanitizer (local). Throws on detection; see
  // activities.ts for why this is modeled as a throw, not a result.
  try {
    await runTitaniumSanitizer({ traceId: canonicalTraceId, rawPayloadText: input.rawPayloadText });
  } catch (err) {
    return {
      status: 'SANITIZER_REJECTED',
      traceId: canonicalTraceId,
      reason: err instanceof ApplicationFailure ? err.message : 'Titanium Sanitizer rejected the payload.',
    };
  }

  // Step 3a — Compute the fraud vector. LOCAL. This is the one and only
  // point in this entire workflow where raw PII is read.
  const { fraudVector } = await computeFraudVectorToken({
    traceId: canonicalTraceId,
    deviceFingerprint: input.deviceFingerprint,
    ipAddress: input.ipAddress,
    sessionId: input.sessionId,
  });

  // Step 3b — Cross-Perimeter Compliance: AML/PEP (remote, platform-queue).
  // Carries real names — see activities.ts for why that's legitimate here
  // specifically, unlike the fraud vector call below.
  const amlResult = await runAmlPepScreening({
    traceId: canonicalTraceId,
    tenantId: input.tenantId,
    subjects: [
      { role: 'SENDER', fullName: input.senderFullName },
      { role: 'RECIPIENT', fullName: input.recipientFullName },
    ],
  });

  if (amlResult.outcome === 'MATCH_FOUND') {
    return {
      status: 'AML_PEP_REJECTED',
      traceId: canonicalTraceId,
      matchedRole: amlResult.matchedRole,
      listSource: amlResult.listSource,
    };
  }

  // Step 3c — Cross-Perimeter Compliance: Global Fraud Network (remote,
  // platform-queue). Carries ONLY the salted token + a bucketed amount —
  // never the raw signals that produced the token.
  const fraudResult = await verifyFraudVector({
    traceId: canonicalTraceId,
    tenantId: input.tenantId,
    fraudVector,
    transactionAmountBand: resolveAmountBand(input.amountUzs),
  });

  if (fraudResult.outcome === 'FLAGGED') {
    return {
      status: 'FRAUD_NETWORK_REJECTED',
      traceId: canonicalTraceId,
      networkRiskScore: fraudResult.networkRiskScore,
    };
  }

  // Step 4 — Ledger Execution (local). Fail-closed: a thrown error OR a
  // FAILED business outcome both map to LEDGER_EXECUTION_FAILED — there
  // is no code path here that interprets ambiguity as success.
  try {
    const ledgerResult = await executeLedgerTransfer({
      traceId: canonicalTraceId,
      idempotencyKey: input.idempotencyKey,
      senderAccountRef: input.senderAccountRef,
      recipientAccountRef: input.recipientAccountRef,
      amountUzs: input.amountUzs,
    });

    if (ledgerResult.outcome === 'FAILED') {
      return { status: 'LEDGER_EXECUTION_FAILED', traceId: canonicalTraceId, reason: ledgerResult.reason };
    }

    return {
      status: 'SUCCESS',
      traceId: canonicalTraceId,
      transactionId: ledgerResult.transactionId,
      ledgerSequenceNumber: ledgerResult.ledgerSequenceNumber,
    };
  } catch (err) {
    return {
      status: 'LEDGER_EXECUTION_FAILED',
      traceId: canonicalTraceId,
      reason: err instanceof ApplicationFailure ? err.message : 'Ledger execution failed after exhausting retries.',
    };
  }
}

export function describeOutcome(result: P2PComplianceWorkflowResult): string {
  switch (result.status) {
    case 'SANITIZER_REJECTED':
      return `Sanitizer rejected: ${result.reason}`;
    case 'AML_PEP_REJECTED':
      return `AML/PEP match (${result.matchedRole}, source: ${result.listSource})`;
    case 'FRAUD_NETWORK_REJECTED':
      return `Flagged by Global Fraud Network (risk score: ${result.networkRiskScore})`;
    case 'LEDGER_EXECUTION_FAILED':
      return `Ledger execution failed: ${result.reason}`;
    case 'SUCCESS':
      return `Transfer ${result.transactionId} executed (ledger seq: ${result.ledgerSequenceNumber}).`;
    default:
      return assertUnreachable(result);
  }
}