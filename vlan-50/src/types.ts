// src/types.ts

// ---------------------------------------------------------------------------
// 1. Merchant Registry — the single Postgres-backed source of truth
//    replacing BOTH of the old file's independently-drifting hardcoded
//    objects. One shape, queryable two ways (by alias, by canonical ID),
//    never two separately-maintained copies.
// ---------------------------------------------------------------------------

export type MerchantStatus = 'ACTIVE' | 'SUSPENDED';

export interface MerchantRegistryRecord {
  readonly merchantAlias: string;
  readonly canonicalId: string;
  readonly status: MerchantStatus;
  readonly webhookEndpoint: string;
  /**
   * Resident in Postgres per this task's explicit scope (#2 names Postgres
   * only, unlike this platform's other VLANs which routed secrets through
   * Vault). Worth flagging plainly: storing a webhook-signing secret in
   * the same database as merchant metadata is a real inconsistency with
   * how every other VLAN in this build handles secret material. Built
   * exactly as scoped here — if Vault-backed storage is wanted for
   * consistency with P2P/Credit/Bill-Pay, that's a one-line change to
   * MerchantRegistryStore's implementation, not to this interface.
   */
  readonly sharedSecret: string;
}

export interface MerchantRegistryStore {
  findByAlias(alias: string): Promise<MerchantRegistryRecord | null>;
  findByCanonicalId(canonicalId: string): Promise<MerchantRegistryRecord | null>;
  /**
   * The DB-backed replacement for Block 3.6's free-text substring scan
   * over a hardcoded object's keys. Implementation detail (a SQL ILIKE,
   * a trigram index, whatever) is the store's business, not this
   * interface's — it just needs to return the best alias match for
   * whatever raw customer text didn't carry a structured alias.
   */
  findByFreeText(rawText: string): Promise<MerchantRegistryRecord | null>;
}

// ---------------------------------------------------------------------------
// 2. QR generation & POS delivery abstractions
// ---------------------------------------------------------------------------

export interface GeneratedQrCode {
  readonly imageBuffer: Buffer;
  readonly mimeType: 'image/png';
}

/** Implemented in activities.ts directly against the `qrcode` package — no separate client needed, since there's no network call to abstract away. */
export interface QrCodeGenerator {
  generate(targetUrl: string): Promise<GeneratedQrCode>;
}

export interface PosWebhookHttpRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Readonly<Record<string, unknown>>;
  readonly timeoutMs: number;
}

export interface PosWebhookHttpResponse {
  readonly httpStatus: number;
}

/** Deliberately narrow — same one-job-only interface shape established for Bill-Pay's BillPayHttpClient. */
export interface PosWebhookClient {
  send(request: PosWebhookHttpRequest): Promise<PosWebhookHttpResponse>;
}

export interface CustomerNotifier {
  sendPaymentConfirmation(input: {
    telegramChatId: string;
    traceId: string;
    amountUzs: number;
  }): Promise<void>;
}

export interface MerchantActivityDependencies {
  readonly registryStore: MerchantRegistryStore;
  readonly qrGenerator: QrCodeGenerator;
  readonly webhookClient: PosWebhookClient;
  readonly customerNotifier: CustomerNotifier;
}

// ---------------------------------------------------------------------------
// 3. Workflow input / result
// ---------------------------------------------------------------------------

export interface MerchantCheckoutWorkflowInput {
  readonly traceId: string;
  readonly tenantId: string;
  readonly customerId: string;
  /** Structured alias if the caller has one; raw text fallback handled by the activity, mirroring Block 3.6's resolveMerchantAlias behavior. */
  readonly merchantAlias?: string;
  readonly rawTicketText?: string;
  readonly amountUzs: number;
}

export function buildMerchantWorkflowId(traceId: string): string {
  return `merchant-${traceId}`;
}

interface MerchantOutcomeBase {
  readonly traceId: string;
}

export interface MerchantValidationFailed extends MerchantOutcomeBase {
  readonly status: 'VALIDATION_FAILED';
  /** Joined error codes — MERCHANT_NOT_FOUND, MERCHANT_SUSPENDED, INVALID_CHECKOUT_AMOUNT — ported verbatim from Block 3.6's own combined-reason pattern, not split into separate statuses. */
  readonly reason: string;
}

export interface MerchantCheckoutTimedOut extends MerchantOutcomeBase {
  readonly status: 'PAYMENT_TIMED_OUT';
}

export interface MerchantCheckoutSuccess extends MerchantOutcomeBase {
  readonly status: 'SUCCESS';
  readonly merchantId: string;
  readonly confirmedAmountUzs: number;
  /**
   * Deliberately a flag on the SUCCESS result, not a separate failure
   * status. The customer's payment already cleared by the time this
   * branch is reached — a POS webhook that never got through after
   * Temporal's durable retries exhausted is an ops/support concern for
   * the merchant integration, not a reason to tell the customer their
   * successful payment failed.
   */
  readonly posNotificationDelivered: boolean;
}

export type MerchantCheckoutWorkflowResult =
  | MerchantValidationFailed
  | MerchantCheckoutTimedOut
  | MerchantCheckoutSuccess;

export function assertUnreachable(value: never): never {
  throw new Error(`Unreachable merchant checkout result: ${JSON.stringify(value)}`);
}

// ---------------------------------------------------------------------------
// 4. Internal activity-level results
// ---------------------------------------------------------------------------

export interface MerchantVerified {
  readonly outcome: 'VERIFIED';
  readonly record: MerchantRegistryRecord;
  readonly amountUzs: number;
}

export interface MerchantInvalid {
  readonly outcome: 'INVALID';
  readonly reason: string;
}

export type MerchantVerificationResult = MerchantVerified | MerchantInvalid;

export function assertVerificationUnreachable(value: never): never {
  throw new Error(`Unreachable merchant verification result: ${JSON.stringify(value)}`);
}