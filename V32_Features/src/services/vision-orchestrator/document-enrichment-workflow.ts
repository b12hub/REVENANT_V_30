// document-enrichment-workflow.ts
//
// The durable pipeline. Vision inference and ledger lookups both take
// real time and both can transiently fail — exactly the "don't block a
// live conversation on a multi-second external call" problem Temporal
// solves, the same reasoning behind every other Workflow in this build.
//
// THE CENTRAL ARCHITECTURAL RULE, stated once, in full, here: the Vision
// Model's output supplies a LOOKUP KEY and a COMPARISON CANDIDATE — never
// a fact. There are three independent reasons the ledger validation step
// is what actually determines truth, not the vision extraction:
//   1. Vision-language models are known to hallucinate plausible-looking
//      values that aren't actually present in the source image — this is
//      a documented failure mode of the model class, not a tunable edge
//      case.
//   2. Fine-grained numeric OCR (the exact digits of an amount, a
//      reference ID) is exactly the kind of detail these models are
//      weakest at — a single transposed digit silently changes a
//      receipt's claimed amount.
//   3. A user can deliberately upload a doctored or entirely fabricated
//      image specifically to get the conversational AI to assert
//      something false to them (or to a downstream process) — "the
//      screenshot shows my transfer succeeded" is not evidence a transfer
//      succeeded. The bank's own ledger, looked up deterministically by
//      whatever reference the image CLAIMS to have, is the only thing in
//      this pipeline with any actual authority.
//
// Raw image bytes appear in NEITHER the workflow input/output NOR in any
// inter-Activity payload — only storage references do, at every step,
// including the deliberately NEW reference minted after sanitization. See
// the conversational note above for why that's a real security property,
// not just tidiness.

import { proxyActivities } from '@temporalio/workflow';
import type { DocumentType, ExtractedDocumentData, VerifiedVisualContext } from './vision-types.js';
import { assertVisualContextUnreachable } from './vision-types.js';

// ---------------------------------------------------------------------------
// Activity interface
// ---------------------------------------------------------------------------

export interface SanitizationRejected {
  readonly outcome: 'REJECTED';
  readonly reason: string;
}
export interface SanitizationAccepted {
  readonly outcome: 'ACCEPTED';
  /** A NEW storage reference — deliberately not the same key as the original upload. The original, unsanitized reference is never returned to or held by the workflow past this point. */
  readonly sanitizedImageRef: string;
}
export type SanitizationResult = SanitizationRejected | SanitizationAccepted;
export function assertSanitizationUnreachable(value: never): never {
  throw new Error(`Unreachable sanitization result: ${JSON.stringify(value)}`);
}

export interface ExtractionNoUsableData {
  readonly outcome: 'NO_USABLE_DATA';
  readonly reason: string;
}
export interface ExtractionSucceeded {
  readonly outcome: 'EXTRACTED';
  readonly data: ExtractedDocumentData;
}
export type ExtractionResult = ExtractionNoUsableData | ExtractionSucceeded;
export function assertExtractionUnreachable(value: never): never {
  throw new Error(`Unreachable extraction result: ${JSON.stringify(value)}`);
}

export interface DocumentEnrichmentActivities {
  sanitizeDocumentActivity(input: { imageId: string }): Promise<SanitizationResult>;
  extractStructuredDataActivity(input: { sanitizedImageRef: string; expectedDocumentType: DocumentType }): Promise<ExtractionResult>;
  /**
   * Performs the deterministic lookup and returns the FINAL
   * VerifiedVisualContext directly — the ledger-matching logic and the
   * "shape the output as only-verified-claims" logic are the same
   * operation, not two separable steps, which is why this Activity
   * returns VerifiedVisualContext rather than a bare LedgerMatchOutcome
   * the workflow would have to assemble itself.
   */
  validateAgainstLedgerActivity(input: {
    customerId: string;
    documentType: DocumentType;
    extracted: ExtractedDocumentData;
  }): Promise<VerifiedVisualContext>;
  emitVisualContextUpdatedActivity(input: {
    conversationId: string;
    customerId: string;
    context: VerifiedVisualContext;
  }): Promise<void>;
}

// ---------------------------------------------------------------------------
// Retry policies
// ---------------------------------------------------------------------------

/** Sanitization: fast, internal. A malicious-signature rejection is definitive — never retried. */
const sanitizationActivities = proxyActivities<DocumentEnrichmentActivities>({
  startToCloseTimeout: '5 seconds',
  retry: {
    initialInterval: '500ms',
    backoffCoefficient: 2,
    maximumInterval: '5 seconds',
    maximumAttempts: 3,
  },
});

/**
 * Vision extraction: an external, often-rate-limited API call — the same
 * underlying infrastructure class (and the same 429 realities) this
 * platform already has an established policy for from F5's LLM-rate-limit
 * lesson. Reusing that exact reasoning here: a generous maximumInterval
 * lets a token bucket actually refill rather than hammering a 429 with
 * tight backoff and giving up.
 */
const extractionActivities = proxyActivities<DocumentEnrichmentActivities>({
  startToCloseTimeout: '30 seconds',
  retry: {
    initialInterval: '2 seconds',
    backoffCoefficient: 2,
    maximumInterval: '90 seconds',
    maximumAttempts: 6,
  },
});

/** Ledger validation: fast, internal, low risk — standard profile. */
const ledgerActivities = proxyActivities<DocumentEnrichmentActivities>({
  startToCloseTimeout: '5 seconds',
  retry: {
    initialInterval: '500ms',
    backoffCoefficient: 2,
    maximumInterval: '5 seconds',
    maximumAttempts: 4,
  },
});

/** Event emission back to F6: moderate retry against a transient delivery failure, capped — this is a notification, not a financial side effect, so no conservative 1-2-attempt cap is needed here the way it is for disbursement-class Activities elsewhere in this build. */
const eventEmissionActivities = proxyActivities<DocumentEnrichmentActivities>({
  startToCloseTimeout: '5 seconds',
  retry: {
    initialInterval: '500ms',
    backoffCoefficient: 2,
    maximumInterval: '10 seconds',
    maximumAttempts: 5,
  },
});

const { sanitizeDocumentActivity } = sanitizationActivities;
const { extractStructuredDataActivity } = extractionActivities;
const { validateAgainstLedgerActivity } = ledgerActivities;
const { emitVisualContextUpdatedActivity } = eventEmissionActivities;

// ---------------------------------------------------------------------------
// Workflow input / result
// ---------------------------------------------------------------------------

export interface DocumentEnrichmentWorkflowInput {
  readonly imageId: string;
  readonly customerId: string;
  readonly conversationId: string;
  /** What the conversation context expected this upload to be (e.g. the user tapped "upload receipt") — informs extraction, but does not override whatever the Vision Model actually detects; see extractStructuredDataActivity's input shape. */
  readonly expectedDocumentType: DocumentType;
}

interface EnrichmentOutcomeBase {
  readonly imageId: string;
  readonly conversationId: string;
}

export interface EnrichmentSanitizationRejected extends EnrichmentOutcomeBase {
  readonly status: 'SANITIZATION_REJECTED';
  readonly reason: string;
}

export interface EnrichmentExtractionFailed extends EnrichmentOutcomeBase {
  readonly status: 'EXTRACTION_FAILED';
  readonly reason: string;
}

export interface EnrichmentCompleted extends EnrichmentOutcomeBase {
  readonly status: 'COMPLETED';
  readonly context: VerifiedVisualContext;
  /**
   * Whether F6 was successfully notified — a delivery-tracking flag on
   * the SUCCESS result, not a separate terminal status. Mirrors the same
   * pattern this build already established for Merchant's
   * `posNotificationDelivered`: the underlying analysis (ledger match
   * outcome) is the meaningful business result regardless of whether the
   * downstream notification happened to land.
   */
  readonly orchestratorNotified: boolean;
}

export type DocumentEnrichmentWorkflowResult =
  | EnrichmentSanitizationRejected
  | EnrichmentExtractionFailed
  | EnrichmentCompleted;

export function assertEnrichmentUnreachable(value: never): never {
  throw new Error(`Unreachable document enrichment result: ${JSON.stringify(value)}`);
}

// ---------------------------------------------------------------------------
// Workflow
// ---------------------------------------------------------------------------

export async function DocumentEnrichmentWorkflow(
  input: DocumentEnrichmentWorkflowInput,
): Promise<DocumentEnrichmentWorkflowResult> {
  // Step 1 — Sanitize. The workflow holds only `input.imageId` (the
  // ORIGINAL reference) up to this point, and never again after it.
  const sanitization = await sanitizeDocumentActivity({ imageId: input.imageId });

  let sanitizedImageRef: string;
  switch (sanitization.outcome) {
    case 'REJECTED':
      return { status: 'SANITIZATION_REJECTED', imageId: input.imageId, conversationId: input.conversationId, reason: sanitization.reason };
    case 'ACCEPTED':
      sanitizedImageRef = sanitization.sanitizedImageRef;
      break;
    default:
      assertSanitizationUnreachable(sanitization);
  }

  // Step 2 — Extract. Only the SANITIZED reference is ever passed onward
  // from this point forward — `input.imageId` is not referenced again
  // anywhere below this line.
  const extraction = await extractStructuredDataActivity({
    sanitizedImageRef,
    expectedDocumentType: input.expectedDocumentType,
  });

  let extractedData: ExtractedDocumentData;
  switch (extraction.outcome) {
    case 'NO_USABLE_DATA':
      return { status: 'EXTRACTION_FAILED', imageId: input.imageId, conversationId: input.conversationId, reason: extraction.reason };
    case 'EXTRACTED':
      extractedData = extraction.data;
      break;
    default:
      assertExtractionUnreachable(extraction);
  }

  // Step 3 — Validate against the ledger. This is the step that actually
  // determines truth — see the file header for the full reasoning. The
  // returned VerifiedVisualContext is already shaped to contain only
  // verified claims; this workflow does not reach into `extractedData`
  // again after this call to construct anything customer-facing.
  const verifiedContext = await validateAgainstLedgerActivity({
    customerId: input.customerId,
    documentType: input.expectedDocumentType,
    extracted: extractedData,
  });

  // Step 4 — Notify F6. A failure here (even after the retry policy
  // above exhausts) does not change the analysis result itself — see
  // EnrichmentCompleted's orchestratorNotified comment.
  let orchestratorNotified = true;
  try {
    await emitVisualContextUpdatedActivity({
      conversationId: input.conversationId,
      customerId: input.customerId,
      context: verifiedContext,
    });
  } catch (err) {
    orchestratorNotified = false;
  }

  return {
    status: 'COMPLETED',
    imageId: input.imageId,
    conversationId: input.conversationId,
    context: verifiedContext,
    orchestratorNotified,
  };
}

export function describeOutcome(result: DocumentEnrichmentWorkflowResult): string {  switch (result.status) {
    case 'SANITIZATION_REJECTED':
      return `Sanitization rejected: ${result.reason}`;
    case 'EXTRACTION_FAILED':
      return `Extraction failed: ${result.reason}`;
    case 'COMPLETED': {
      const { context } = result;
      switch (context.matchOutcome) {
        case 'MATCHED':
          return `Verified match: ${context.verifiedClaims.referenceId} (orchestrator notified: ${result.orchestratorNotified}).`;
        case 'NOT_FOUND':
          return `No ledger entry found for claimed reference ${context.attemptedReferenceIdClaim ?? 'unknown'} (orchestrator notified: ${result.orchestratorNotified}).`;
        case 'AMOUNT_MISMATCH':
          return `Amount mismatch on ${context.ledgerReferenceId}: ledger=${context.ledgerAmount}, claimed=${context.documentClaimedAmount} (orchestrator notified: ${result.orchestratorNotified}).`;
        case 'CURRENCY_MISMATCH':
          return `Currency mismatch on ${context.ledgerReferenceId}: ledger=${context.ledgerCurrency}, claimed=${context.documentClaimedCurrency} (orchestrator notified: ${result.orchestratorNotified}).`;
        default:
          return assertVisualContextUnreachable(context);
      }
    }
    default:
      return assertEnrichmentUnreachable(result);
  }
}