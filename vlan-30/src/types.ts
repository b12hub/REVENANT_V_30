// src/types.ts

// ---------------------------------------------------------------------------
// 1. Provider Registry — the Postgres-resident replacement for the old
//    hardcoded REGISTRY object. This interface describes a row; the actual
//    query layer is explicitly out of scope for this phase per your
//    instruction.
// ---------------------------------------------------------------------------

/**
 * The closed set of generic fields a field_mapping_schema entry can map
 * FROM. This is the direct cause of the simplification described in the
 * conversational note above: because BillPayRequest is flat, this is a
 * fixed, small, known list — not an arbitrary dotted path into a nested
 * ticket structure the way the old `source_field` strings were.
 */
export const GENERIC_PAYMENT_FIELDS = [
  'identifier',
  'amountUzs',
  'traceId',
  'idempotencyKey',
] as const;
export type GenericPaymentField = (typeof GENERIC_PAYMENT_FIELDS)[number];

export interface FieldMappingEntry {
  readonly sourceField: GenericPaymentField;
  /** The provider's expected JSON key, e.g. "pinfl_or_account", "inn". */
  readonly targetField: string;
}

/**
 * How a fetched secret gets framed into an HTTP header — see the
 * conversational note on why this is a discriminator now rather than
 * protocol framing baked into the stored secret string itself.
 */
export type AuthMethod = 'RAW_HEADER_VALUE' | 'BEARER_TOKEN';

/**
 * Response shapes are NOT ours to flatten — third-party APIs return
 * whatever shape they return. Path-based lookup is genuinely necessary
 * here, unlike the outbound side.
 */
export interface ResponseFieldMapping {
  readonly transactionIdPath: string; // e.g. "payment_uuid", or "data.receipt.id" for a nested response
  readonly statusPath: string;
  readonly amountPath: string;
}

export interface ResponseMappingSchema {
  readonly fieldMapping: ResponseFieldMapping;
  /** Provider-specific status string -> our universal status. Anything not listed maps to FAILED at the activity layer, not UNKNOWN — an unrecognized status from a provider is a real problem worth surfacing as a failure, not silently swallowed. */
  readonly statusMap: Readonly<Record<string, 'SUCCESS' | 'FAILED' | 'PENDING'>>;
}

/**
 * One row of the provider_registry table. tenant_id is included
 * deliberately — see the conversational note: different bank tenants may
 * hold separate commercial contracts (and therefore separate Vault
 * secrets, possibly even separate endpoints) with what's nominally "the
 * same" provider_code, consistent with this platform's established
 * per-tenant Vault namespacing.
 */
export interface ProviderRegistryRecord {
  readonly tenantId: string;
  readonly providerCode: string;
  readonly endpointUrl: string;
  readonly httpMethod: 'POST' | 'PUT';
  readonly authHeaderName: string;
  readonly authMethod: AuthMethod;
  /** Path into Vault — e.g. "secret/data/tenants/{tenantId}/billpay/uzbekenergo". The actual secret VALUE is never stored here. */
  readonly vaultSecretPath: string;
  readonly fieldMapping: readonly FieldMappingEntry[];
  readonly responseMapping: ResponseMappingSchema;
  readonly timeoutMs: number;
  readonly isActive: boolean;
}

/** Read-only abstraction — write/migration concerns are explicitly out of scope for this phase. */
export interface ProviderRegistryStore {
  getActiveProvider(tenantId: string, providerCode: string): Promise<ProviderRegistryRecord | null>;
}

// ---------------------------------------------------------------------------
// 2. Secrets Manager (Vault) abstraction — directive #2's "clean interface."
//    Deliberately knows NOTHING about providers or tenants; it resolves a
//    path to a value, full stop. Tenant/provider scoping lives entirely in
//    the PATH STRING the registry record supplies, not in this interface's
//    shape — keeping Vault genuinely decoupled from billpay's domain model.
// ---------------------------------------------------------------------------

export interface SecretsManager {
  fetchSecret(secretPath: string): Promise<string>;
}

// ---------------------------------------------------------------------------
// 3. Workflow input / discriminated result — same exhaustiveness pattern
//    established for P2P and reused for FAQ, kept consistent here.
// ---------------------------------------------------------------------------

export interface BillPayWorkflowInput {
  readonly traceId: string;
  readonly tenantId: string;
  readonly customerId: string;
  readonly providerCode: string;
  readonly identifier: string;
  readonly amountUzs: number;
}

export function buildBillPayWorkflowId(traceId: string, providerCode: string): string {
  return `billpay-${providerCode}-${traceId}`;
}

export type BillPayOutcomeStatus =
  | 'SUCCESS'
  | 'FAILED'
  | 'PENDING'
  | 'UNKNOWN_PROVIDER'
  | 'PROVIDER_UNAVAILABLE'
  | 'CONFIGURATION_ERROR';

interface BillPayOutcomeBase {
  readonly traceId: string;
  readonly idempotencyKey: string;
}

export interface BillPaySuccess extends BillPayOutcomeBase {
  readonly status: 'SUCCESS';
  readonly providerTransactionId: string;
  readonly confirmedAmountUzs: number;
}

export interface BillPayFailed extends BillPayOutcomeBase {
  readonly status: 'FAILED';
  readonly errorDetail: string;
}

export interface BillPayPending extends BillPayOutcomeBase {
  readonly status: 'PENDING';
  readonly providerTransactionId: string;
}

export interface BillPayUnknownProvider extends BillPayOutcomeBase {
  readonly status: 'UNKNOWN_PROVIDER';
}

export interface BillPayProviderUnavailable extends BillPayOutcomeBase {
  readonly status: 'PROVIDER_UNAVAILABLE';
  readonly errorDetail: string;
}

export interface BillPayConfigurationError extends BillPayOutcomeBase {
  readonly status: 'CONFIGURATION_ERROR';
  readonly errorDetail: string;
}

export type BillPayWorkflowResult =
  | BillPaySuccess
  | BillPayFailed
  | BillPayPending
  | BillPayUnknownProvider
  | BillPayProviderUnavailable
  | BillPayConfigurationError;

export function assertUnreachable(value: never): never {
  throw new Error(`Unreachable code reached with value: ${JSON.stringify(value)}`);
}

// ---------------------------------------------------------------------------
// 4. Activity dependency injection bag — same DI pattern as P2P's
//    P2PActivityDependencies, for the same testability reason.
// ---------------------------------------------------------------------------

export interface BillPayActivityDependencies {
  readonly providerRegistryStore: ProviderRegistryStore;
  readonly secretsManager: SecretsManager;
  /** Injected so activities.ts never imports a concrete HTTP library directly — see activities.ts header. */
  readonly httpClient: BillPayHttpClient;
}

/**
 * Minimal HTTP abstraction. Deliberately narrow (one method, fixed shape)
 * rather than exposing a full HTTP client interface — activities.ts has
 * exactly one kind of call to make, and a narrower interface is what keeps
 * Phase-4-style test mocks trivial to write.
 */
export interface BillPayHttpRequest {
  readonly method: 'POST' | 'PUT';
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Readonly<Record<string, unknown>>;
  readonly timeoutMs: number;
}

export interface BillPayHttpResponse {
  readonly httpStatus: number;
  readonly body: unknown; // unknown, not Record<string, unknown> — a provider could return a non-object; response-mapping code must handle that, not assume it away
}

export interface BillPayHttpClient {
  send(request: BillPayHttpRequest): Promise<BillPayHttpResponse>;
}