export interface P2PTransferWorkflowInput {
  readonly traceId: string;
  readonly tenantId: string;
  readonly customerId: string;
  readonly phone: string; 
  readonly amountUzs: number;
  readonly rawRecipientText: string;
  readonly idempotencyKey: string;
}

export function buildP2PWorkflowId(traceId: string): string {
  return `p2p-${traceId}`;
}

export type P2PTransferOutcomeStatus =
  | 'SUCCESS'
  | 'DECLINED'
  | 'TIMED_OUT'
  | 'CALLBACK_VERIFICATION_FAILED'
  | 'IDEMPOTENCY_DUPLICATE'
  | 'RECIPIENT_RESOLUTION_FAILED'
  | 'EXECUTION_FAILED';

interface P2PTransferOutcomeBase {
  readonly traceId: string;
}

export interface P2PTransferSuccess extends P2PTransferOutcomeBase {
  readonly status: 'SUCCESS';
  readonly transactionId: string;
  readonly recipientAccountMasked: string;
  readonly providerReference: string;
}

export interface P2PTransferDeclined extends P2PTransferOutcomeBase {
  readonly status: 'DECLINED';
  readonly reason: string;
}

export interface P2PTransferTimedOut extends P2PTransferOutcomeBase {
  readonly status: 'TIMED_OUT';
}

export interface P2PTransferCallbackVerificationFailed extends P2PTransferOutcomeBase {
  readonly status: 'CALLBACK_VERIFICATION_FAILED';
  readonly errorDetail: string;
}

export interface P2PTransferIdempotencyDuplicate extends P2PTransferOutcomeBase {
  readonly status: 'IDEMPOTENCY_DUPLICATE';
  readonly existingTransactionId: string;
}

export interface P2PTransferRecipientResolutionFailed extends P2PTransferOutcomeBase {
  readonly status: 'RECIPIENT_RESOLUTION_FAILED';
  readonly errorDetail: string;
}

export interface P2PTransferExecutionFailed extends P2PTransferOutcomeBase {
  readonly status: 'EXECUTION_FAILED';
  readonly errorDetail: string;
}

export type P2PTransferWorkflowResult =
  | P2PTransferSuccess
  | P2PTransferDeclined
  | P2PTransferTimedOut
  | P2PTransferCallbackVerificationFailed
  | P2PTransferIdempotencyDuplicate
  | P2PTransferRecipientResolutionFailed
  | P2PTransferExecutionFailed;

export function assertUnreachable(value: never): never {
  throw new Error(`Unreachable code reached with value: ${JSON.stringify(value)}`);
}

export interface CbuAccountResolution {
  readonly accountHolderName: string; 
  readonly maskedAccountNumber: string;
  readonly providerReference: string;
}

export interface CbuClient {
  resolvePhoneToAccount(phone: string): Promise<CbuAccountResolution>;
}

export interface CoreBankingExecutionRequest {
  readonly idempotencyKey: string;
  readonly senderCustomerId: string;
  readonly recipientMaskedAccount: string;
  readonly amountUzs: number;
}

export interface CoreBankingExecutionResult {
  readonly transactionId: string;
  readonly providerReference: string;
}

export interface CoreBankingClient {
  executeP2PTransfer(request: CoreBankingExecutionRequest): Promise<CoreBankingExecutionResult>;
}

export interface IdempotencyCheckResult {
  readonly isDuplicate: boolean;
  readonly existingTransactionId?: string;
}

export interface P2PIdempotencyStore {
  checkAndReserve(idempotencyKey: string): Promise<IdempotencyCheckResult>;
}

export interface ConfirmationPromptRequest {
  readonly workflowId: string;
  readonly telegramChatId: string;
  readonly phone: string;
  readonly amountUzs: number;
  readonly sanitizedRecipientName: string;
}

export interface TelegramNotifier {
  sendConfirmationPrompt(request: ConfirmationPromptRequest, signedCallbackData: string): Promise<void>;
}

export interface P2PActivityDependencies {
  readonly cbuClient: CbuClient;
  readonly coreBankingClient: CoreBankingClient;
  readonly idempotencyStore: P2PIdempotencyStore;
  readonly telegramNotifier: TelegramNotifier;
  readonly confirmationSecretKey: Uint8Array;
  readonly confirmationTtlMinutes: number; 
}

export type P2PActivityErrorCode =
  | 'VALIDATION_ERROR'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_UNAVAILABLE'
  | 'PHONE_NOT_REGISTERED' 
  | 'CALLBACK_VERIFICATION_FAILED'
  | 'IDEMPOTENCY_DUPLICATE'
  | 'LEDGER_FAILURE';