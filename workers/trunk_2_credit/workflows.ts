/**
 * workflows.ts
 *
 * REVENANT v32 — Trunk 2: Credit Execution
 *
 * `CreditDisbursementTrunkWorkflow` orchestrates the credit application
 * lifecycle end to end, hopping deliberately between two trust perimeters:
 *
 *   1. Request Verification              — LOCAL  (credit-queue)
 *   2. AI Credit Eligibility              — REMOTE (platform-queue)
 *   3. Cross-Perimeter Compliance         — LOCAL tokenization + REMOTE lookups
 *   4. e-Signature Validation             — LOCAL  (credit-queue)
 *   5. Credit Disbursement Ledger         — LOCAL  (credit-queue, fail-closed)
 *
 * Naming: this workflow is intentionally named `CreditDisbursementTrunkWorkflow`
 * rather than reusing any legacy "Trunk 2" identifier, so that registering it
 * alongside still-running legacy n8n-derived workflow executions cannot
 * collide on workflow type name during the migration window.
 *
 * Determinism: this file touches only `workflowInfo()` for any
 * execution-scoped identifiers it needs (e.g. building an idempotency key).
 * It never imports `node:crypto`, never calls `Math.random()`, and never
 * constructs wall-clock timestamps itself — all timestamps returned to
 * callers originate from activity results, which are free to use real
 * system time because activities, unlike workflow code, are not replayed.
 */


import { proxyActivities, ApplicationFailure, workflowInfo } from '@temporalio/workflow';
import type { DataClassificationTier, LocalActivitiesType, RemoteActivitiesType } from './activities.js';

// ---------------------------------------------------------------------------
// Activity proxies — three independent queue/retry topologies
// ---------------------------------------------------------------------------

/**
 * Fast local activities (`credit-queue`): signature validation and PII
 * tokenization. Wired directly to the explicit LocalActivitiesType boundary.
 */
const fastLocalActivities = proxyActivities<LocalActivitiesType>({
    taskQueue: 'credit-queue',
    startToCloseTimeout: '5 seconds',
    retry: {
        initialInterval: '500 milliseconds',
        backoffCoefficient: 2,
        maximumInterval: '5 seconds',
        maximumAttempts: 4,
    },
});

/**
 * Platform activities (`platform-queue`): AI credit scoring, AML/PEP, and
 * global fraud network lookups. Wired directly to the RemoteActivitiesType boundary.
 */
const platformActivities = proxyActivities<RemoteActivitiesType>({
    taskQueue: 'platform-queue',
    startToCloseTimeout: '2 minutes',
    scheduleToCloseTimeout: '10 minutes',
    retry: {
        initialInterval: '2 seconds',
        backoffCoefficient: 2,
        maximumInterval: '1 minute',
        maximumAttempts: 8,
    },
});

/**
 * Ledger execution activities (`credit-queue`): actual money movement.
 * Uses a subset of the local activities specifically for disbursement execution.
 */
const ledgerExecutionActivities = proxyActivities<LocalActivitiesType>({
    taskQueue: 'credit-queue',
    startToCloseTimeout: '15 seconds',
    retry: {
        initialInterval: '1 second',
        backoffCoefficient: 1,
        maximumAttempts: 2,
    },
});

// ---------------------------------------------------------------------------
// Workflow input / output contracts
// ---------------------------------------------------------------------------

export interface CreditDisbursementTrunkInput {
    readonly applicationId: string;

    // Step 1 — Request Verification
    readonly canonicalPayload: string;
    readonly signatureBase64: string;
    readonly signingKeyId: string;

    // Step 2 — AI Credit Eligibility
    /** String, never `number` — eliminates floating-point serialization risk over gRPC. */
    readonly requestedAmountUzs: string;
    readonly applicantContext: Readonly<Record<string, string | number | boolean>>;
    readonly dataClassification: DataClassificationTier;

    // Step 3 — Cross-Perimeter Compliance
    readonly fullNameHash: string;
    readonly nationalIdHash: string;
    readonly dateOfBirthIso: string;
    readonly deviceId: string;
    readonly sourceIp: string;
    readonly phoneNumber: string;
    readonly saltKeyId: string;

    // Step 4 — e-Signature Validation
    readonly capturedSignatureHash: string;
    readonly authorizedSignatureToken: string;

    // Step 5 — Credit Disbursement Ledger
    readonly disbursementAccountIban: string;
}

/**
 * Discriminated union of every non-security business outcome the workflow
 * can resolve to. Security events (signature tampering) never reach this
 * union — they are raised as non-retryable `ApplicationFailure`s instead,
 * so callers can rely on "if this resolves, it was not a tamper event."
 */
export type CreditDisbursementOutcome =
    | {
        readonly outcome: 'AI_REJECTED';
        readonly applicationId: string;
        readonly riskScore: number;
        readonly reasonCodes: readonly string[];
    }
    | {
        readonly outcome: 'AML_PEP_REJECTED';
        readonly applicationId: string;
        readonly screeningStatus: 'PEP_MATCH' | 'AML_HIT' | 'INCONCLUSIVE';
        readonly screeningProviderRef: string;
    }
    | {
        readonly outcome: 'FRAUD_REJECTED';
        readonly applicationId: string;
        readonly fraudStatus: 'FLAGGED' | 'BLOCKED';
        readonly globalNetworkRef: string;
    }
    | {
        readonly outcome: 'DISBURSEMENT_FAILED';
        readonly applicationId: string;
        readonly ledgerTransactionId: string;
    }
    | {
        readonly outcome: 'SUCCESS';
        readonly applicationId: string;
        readonly ledgerTransactionId: string;
        readonly disbursedAtIso: string;
    };

// ---------------------------------------------------------------------------
// Workflow
// ---------------------------------------------------------------------------

export async function CreditDisbursementTrunkWorkflow(
    input: CreditDisbursementTrunkInput,
): Promise<CreditDisbursementOutcome> {
    const info = workflowInfo();

    // -- Step 1: Request Verification (Local) --------------------------------
    // A failed signature check means the inbound application cannot be
    // trusted to represent what the client actually submitted. This is a
    // security event, not a business outcome: fail the workflow outright,
    // non-retryable, so it surfaces immediately to security tooling rather
    // than being absorbed into a typed result the caller might log quietly.
    const signatureCheck = await fastLocalActivities.verifyRequestSignature({
        applicationId: input.applicationId,
        canonicalPayload: input.canonicalPayload,
        signatureBase64: input.signatureBase64,
        signingKeyId: input.signingKeyId,
    });

    if (!signatureCheck.valid) {
        throw ApplicationFailure.create({
            message: `Request signature verification failed for applicationId=${input.applicationId}`,
            type: 'REQUEST_SIGNATURE_INVALID',
            nonRetryable: true,
        });
    }

    // -- Step 2: AI Credit Eligibility (Remote) -------------------------------
    const eligibility = await platformActivities.evaluateAiCreditEligibility({
        applicationId: input.applicationId,
        requestedAmountUzs: input.requestedAmountUzs,
        applicantContext: input.applicantContext,
        dataClassification: input.dataClassification,
    });

    if (!eligibility.eligible) {
        return {
            outcome: 'AI_REJECTED',
            applicationId: input.applicationId,
            riskScore: eligibility.riskScore,
            reasonCodes: eligibility.reasonCodes,
        };
    }

    // -- Step 3: Cross-Perimeter Compliance (Remote, gated by Local tokenization) --
    const amlResult = await platformActivities.runAmlPepScreening({
        applicationId: input.applicationId,
        fullNameHash: input.fullNameHash,
        nationalIdHash: input.nationalIdHash,
        dateOfBirthIso: input.dateOfBirthIso,
    });

    if (amlResult.status !== 'CLEAR') {
        return {
            outcome: 'AML_PEP_REJECTED',
            applicationId: input.applicationId,
            screeningStatus: amlResult.status,
            screeningProviderRef: amlResult.screeningProviderRef,
        };
    }

    // Raw device/network PII is tokenized LOCALLY before any reference to it
    // is allowed to cross into the SaaS Edge for the Global Fraud Network call.
    const fraudToken = await fastLocalActivities.computeFraudVectorToken({
        applicationId: input.applicationId,
        deviceId: input.deviceId,
        sourceIp: input.sourceIp,
        phoneNumber: input.phoneNumber,
        saltKeyId: input.saltKeyId,
    });

    const fraudResult = await platformActivities.verifyFraudVector({
        applicationId: input.applicationId,
        fraudVectorToken: fraudToken.fraudVectorToken,
    });

    if (fraudResult.status !== 'CLEAR') {
        return {
            outcome: 'FRAUD_REJECTED',
            applicationId: input.applicationId,
            fraudStatus: fraudResult.status,
            globalNetworkRef: fraudResult.globalNetworkRef,
        };
    }

    // -- Step 4: e-Signature Validation (Local) -------------------------------
    // Like Step 1, a mismatch here is a security event — it indicates the
    // captured consent artifact does not match the authorized signature token
    // — so it is raised as a non-retryable failure rather than folded into
    // the business-outcome union.
    const loanSignature = await fastLocalActivities.verifyLoanSignature({
        applicationId: input.applicationId,
        capturedSignatureHash: input.capturedSignatureHash,
        authorizedSignatureToken: input.authorizedSignatureToken,
    });

    if (!loanSignature.matched) {
        throw ApplicationFailure.create({
            message: `Loan e-signature mismatch for applicationId=${input.applicationId}`,
            type: 'LOAN_SIGNATURE_MISMATCH',
            nonRetryable: true,
        });
    }

    // -- Step 5: Credit Disbursement Ledger (Local, fail-closed) --------------
    // The idempotency key is derived purely from deterministic, replay-safe
    // workflow execution identifiers (workflowId + runId). Uses an underscore
    // delimiter to remain safe for legacy core database string parsing schemas.
    const idempotencyKey = `${info.workflowId}_${info.runId}`;

    const disbursement = await ledgerExecutionActivities.executeCreditDisbursement({
        applicationId: input.applicationId,
        disbursementAccountIban: input.disbursementAccountIban,
        amountUzs: input.requestedAmountUzs,
        idempotencyKey,
    });

    if (disbursement.status !== 'DISBURSED') {
        return {
            outcome: 'DISBURSEMENT_FAILED',
            applicationId: input.applicationId,
            ledgerTransactionId: disbursement.ledgerTransactionId,
        };
    }

    return {
        outcome: 'SUCCESS',
        applicationId: input.applicationId,
        ledgerTransactionId: disbursement.ledgerTransactionId,
        disbursedAtIso: disbursement.disbursedAtIso,
    };
}