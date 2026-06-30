// vision-types.ts

// ---------------------------------------------------------------------------
// 1. Document Type Definition
// ---------------------------------------------------------------------------
export const DOCUMENT_TYPES = [
  'MERCHANT_RECEIPT',
  'P2P_TRANSFER_SCREENSHOT',
  'UTILITY_INVOICE',
  'IDENTITY_DOCUMENT',
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

// ---------------------------------------------------------------------------
// 2. ExtractedDocumentData — Untrusted, raw vision telemetry
// ---------------------------------------------------------------------------
export interface ExtractedDocumentData {
  /** The Vision Model's own classification guess — may disagree with context expectations. */
  readonly detectedDocumentType: DocumentType | 'UNKNOWN';

  readonly merchantNameClaim?: string;
  readonly amountClaim?: number;
  readonly feeClaim?: number;

  /** ISO 4217 Currency Code Claim (e.g., 'UZS', 'USD') */
  readonly currencyClaim?: string;

  /** Raw string read off the document — completely unvalidated calendar format. */
  readonly dateClaim?: string;
  readonly referenceIdClaim?: string;

  /** Metadata specific to local P2P ecosystem parsing (Click, Payme, Uzum) */
  readonly senderMaskedCardClaim?: string;
  readonly recipientMaskedCardClaim?: string;

  /** Vision model self-reported confidence factor [0, 1] for logging/telemetry only. */
  readonly extractionConfidence: number;
}

// ---------------------------------------------------------------------------
// 3. Ledger Match Outcomes
// ---------------------------------------------------------------------------
export const LEDGER_MATCH_OUTCOMES = [
  'MATCHED',
  'NOT_FOUND',
  'AMOUNT_MISMATCH',
  'CURRENCY_MISMATCH'
] as const;
export type LedgerMatchOutcome = (typeof LEDGER_MATCH_OUTCOMES)[number];

// ---------------------------------------------------------------------------
// 4. VerifiedVisualContext — Discriminated Union for Conversational LLM Consumption
// ---------------------------------------------------------------------------
interface VerifiedVisualContextBase {
  readonly documentType: DocumentType | 'UNKNOWN';
}

/**
 * Validated Branch: Everything here represents verified ledger realities,
 * safe for immediate multi-modal context injection.
 */
export interface VerifiedVisualContextMatched extends VerifiedVisualContextBase {
  readonly matchOutcome: 'MATCHED';
  readonly verifiedClaims: {
    readonly merchantName: string;
    readonly ledgerAmount: number;
    readonly ledgerFee: number;
    readonly currency: string;
    readonly settledAtIso: string;
    readonly referenceId: string;
    readonly counterpartyMaskedCard?: string;
  };
}

export interface VerifiedVisualContextNotFound extends VerifiedVisualContextBase {
  readonly matchOutcome: 'NOT_FOUND';
  /** Surfaced strictly as a historical trace to allow conversational fallback patterns. */
  readonly attemptedReferenceIdClaim: string | null;
}

export interface VerifiedVisualContextAmountMismatch extends VerifiedVisualContextBase {
  readonly matchOutcome: 'AMOUNT_MISMATCH';
  readonly ledgerReferenceId: string;
  readonly ledgerAmount: number;
  readonly ledgerFee: number;
  readonly currency: string;
  /** Unverified trace surfaced exclusively to point out the variance to the user. */
  readonly documentClaimedAmount: number;
}

export interface VerifiedVisualContextCurrencyMismatch extends VerifiedVisualContextBase {
  readonly matchOutcome: 'CURRENCY_MISMATCH';
  readonly ledgerReferenceId: string;
  readonly ledgerCurrency: string;
  /** Unverified trace surfaced exclusively to resolve cross-currency conversational context. */
  readonly documentClaimedCurrency: string;
}

export type VerifiedVisualContext =
  | VerifiedVisualContextMatched
  | VerifiedVisualContextNotFound
  | VerifiedVisualContextAmountMismatch
  | VerifiedVisualContextCurrencyMismatch;

export function assertVisualContextUnreachable(value: never): never {
  throw new Error(`Unreachable verified visual context condition reached: ${JSON.stringify(value)}`);
}