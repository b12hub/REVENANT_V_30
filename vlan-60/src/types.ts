// =============================================================================
// REVENANT V31 — F5 (Proactive Nudge & Engagement Service)
// types.ts
//
// Shared contracts for Workflows, Activities, and the Postgres / Telegram /
// OpenAI boundaries. This is the single source of truth for shapes that
// previously lived as loose `json` objects flowing between n8n nodes.
// =============================================================================

// -----------------------------------------------------------------------------
// Nudge taxonomy
// -----------------------------------------------------------------------------

/** Mirrors the three rules in the legacy "Deterministic Nudge Engine" code node. */
export enum NudgeIntent {
  LOW_BALANCE_WARNING = 'LOW_BALANCE_WARNING',
  LOAN_RENEWAL = 'LOAN_RENEWAL',
  SAVINGS_NUDGE = 'SAVINGS_NUDGE',
}

/** Every non-terminal reason an IndividualUserNudgeWorkflow can exit without sending. */
export enum NudgeSkipReason {
  /** No rule matched the customer's financial snapshot — "no trigger, no message, no spam". */
  NO_TRIGGER = 'NO_TRIGGER',
  /** customer has not opted into marketing/nudge communications. */
  CONSENT_NOT_GRANTED = 'CONSENT_NOT_GRANTED',
  /** customer was nudged within the last 72 hours. */
  FREQUENCY_CAPPED = 'FREQUENCY_CAPPED',
  /** a nudge was generated but there is no Telegram chat to deliver it to. */
  MISSING_CHAT_ID = 'MISSING_CHAT_ID',
}

// -----------------------------------------------------------------------------
// Postgres row / aggregate shapes
// -----------------------------------------------------------------------------

export interface UpcomingAutopay {
  amount: number;
  due_date: string; // ISO date, YYYY-MM-DD
  merchant: string;
}

export interface LoanRecord {
  loan_id: string;
  remaining_balance: number;
  maturity_date: string; // ISO date, YYYY-MM-DD
  repayment_history: 'GOOD' | 'LATE' | 'DEFAULTED' | string;
}

/**
 * Result of the Data Aggregation activity. Equivalent to the legacy
 * "Customer State Hydrator" mock node, but backed by real Postgres joins
 * across accounts / autopay_schedule / loans.
 */
export interface CustomerFinancialSnapshot {
  customer_id: string;
  telegram_chat_id: string | null;
  first_name: string;
  current_balance: number;
  upcoming_autopay: UpcomingAutopay | null;
  loan: LoanRecord | null;
  idle_cash_days: number;
}

/** Row shape of the `user_preferences` table backing the consent/frequency gate. */
export interface UserPreferencesRow {
  customer_id: string;
  opt_in_marketing: boolean;
  last_nudge_sent_at: string | null; // ISO timestamp
}

export interface FrequencyGateResult {
  allowed: boolean;
  reason: NudgeSkipReason | null;
  hours_since_last_nudge: number | null;
}

// -----------------------------------------------------------------------------
// Nudge intent + context payloads (mirrors `context_payload` in the n8n flow)
// -----------------------------------------------------------------------------

export interface LowBalanceContext {
  balance: number;
  bill_amount: number;
  due_date: string;
  merchant: string;
}

export interface LoanRenewalContext {
  loan_id: string;
  maturity_date: string;
  remaining_balance: number;
}

export interface SavingsNudgeContext {
  balance: number;
  idle_days: number;
}

export type NudgeContextPayload = LowBalanceContext | LoanRenewalContext | SavingsNudgeContext;

/** Output of the deterministic rule engine — equivalent to the "Deterministic Nudge Engine" node. */
export interface NudgeCandidate {
  customer_id: string;
  telegram_chat_id: string | null;
  first_name: string;
  nudge_intent: NudgeIntent;
  context_payload: NudgeContextPayload;
}

// -----------------------------------------------------------------------------
// LLM personalization layer (replaces the LangChain "Basic LLM Chain" node)
// -----------------------------------------------------------------------------

export interface LlmNudgeRequest {
  nudge_intent: NudgeIntent;
  first_name: string;
  context_payload: NudgeContextPayload;
}

export interface LlmNudgeResponse {
  /** Plain Telegram-ready Uzbek text, already validated as non-empty. */
  text: string;
  model: string;
}

// -----------------------------------------------------------------------------
// Telegram dispatch (replaces "Outbound Dispatcher Builder" + "Send a text message")
// -----------------------------------------------------------------------------

export interface TelegramInlineKeyboardButton {
  text: string;
  callback_data: string;
}

export interface TelegramSendMessagePayload {
  chat_id: string;
  text: string;
  parse_mode: 'HTML';
  reply_markup?: {
    inline_keyboard: TelegramInlineKeyboardButton[][];
  };
}

export interface TelegramDispatchResult {
  ok: boolean;
  telegram_message_id?: number;
  /** Non-fatal warning, e.g. NO_CUSTOMER_ID_FOR_NUDGE / CALLBACK_DATA_EXCEEDS_64_BYTES. */
  warning?: string;
}

// -----------------------------------------------------------------------------
// Activity argument/result types not covered above
// -----------------------------------------------------------------------------

export interface EligibleCustomerPage {
  ids: string[];
  nextCursor: number;
  /** true once this page is the last page of eligible customers. */
  done: boolean;
}

export interface EligibleCustomerPageArgs {
  cursor: number;
  limit: number;
}

// -----------------------------------------------------------------------------
// Workflow inputs / outputs
// -----------------------------------------------------------------------------

export interface DailyNudgeRunTotals {
  scanned: number;
  childrenStarted: number;
}

export interface DailyNudgeCronWorkflowInput {
  /** Pagination cursor — offset into the eligible-customer query. Defaults to 0. */
  cursor?: number;
  /** Page size per Temporal execution — bounds this workflow's history growth. */
  batchSize?: number;
  /** Running totals carried across continueAsNew hops, for observability only. */
  totalsSoFar?: DailyNudgeRunTotals;
}

export interface IndividualUserNudgeWorkflowInput {
  customer_id: string;
}

export interface IndividualUserNudgeWorkflowResult {
  customer_id: string;
  sent: boolean;
  nudge_intent?: NudgeIntent;
  skip_reason?: NudgeSkipReason;
}