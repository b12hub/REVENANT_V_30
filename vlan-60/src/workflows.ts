// =============================================================================
// REVENANT V31 — F5 (Proactive Nudge & Engagement Service)
// workflows.ts
//
// Two workflows:
//
//   DailyNudgeCronWorkflow      Scheduled once a day (see README — Temporal
//                               Schedule, replacing the n8n Schedule Trigger
//                               that fired at 09:00). Pages through eligible
//                               customer_ids in bounded batches and fans each
//                               one out to its own child workflow. Never
//                               loads more than `batchSize` records into
//                               memory, and uses continueAsNew between pages
//                               so its own history never grows unbounded
//                               across "thousands of users".
//
//   IndividualUserNudgeWorkflow One per customer. Runs the consent/frequency
//                               gate, aggregates financial data, applies the
//                               deterministic rule engine, personalizes via
//                               LLM, and dispatches to Telegram. Exits
//                               gracefully (no error, no message) whenever a
//                               gate isn't satisfied.
// =============================================================================

import { proxyActivities, startChild, continueAsNew, ParentClosePolicy } from '@temporalio/workflow';
import type * as activities from './activities';
import {
  NudgeIntent,
  NudgeSkipReason,
  type CustomerFinancialSnapshot,
  type NudgeCandidate,
  type TelegramInlineKeyboardButton,
  type TelegramSendMessagePayload,
  type DailyNudgeCronWorkflowInput,
  type DailyNudgeRunTotals,
  type IndividualUserNudgeWorkflowInput,
  type IndividualUserNudgeWorkflowResult,
} from './types';

// -----------------------------------------------------------------------------
// Activity proxies — deliberately split into three groups, each with a retry
// policy tuned to that dependency's actual failure characteristics. This is
// the core of "OpenAI Rate Limit Resilience": the LLM call gets its own
// generous, long-tailed backoff so a 429 burst is absorbed instead of
// dropping the nudge.
// -----------------------------------------------------------------------------

/** Fast, transactional Postgres reads/writes. Fail fast, retry quickly. */
const db = proxyActivities<typeof activities>({
  startToCloseTimeout: '10 seconds',
  retry: {
    initialInterval: '1 second',
    backoffCoefficient: 2,
    maximumInterval: '30 seconds',
    maximumAttempts: 5,
    nonRetryableErrorTypes: ['PostgresValidationError'],
  },
});

/**
 * The OpenAI call. HTTP 429 from OpenAI means "your token bucket is empty,
 * try again shortly" — NOT "this request is broken". A short backoff cap
 * would just hammer the API and burn through retries before the bucket
 * refills, so maximumInterval is set to a full 2 minutes and maximumAttempts
 * is generous enough to ride out a multi-minute rate-limit window.
 */
const llm = proxyActivities<typeof activities>({
  startToCloseTimeout: '60 seconds',
  retry: {
    initialInterval: '5 seconds',
    backoffCoefficient: 2,
    maximumInterval: '2 minutes',
    maximumAttempts: 8,
    nonRetryableErrorTypes: ['OpenAIInvalidRequestError'],
  },
});

/** Telegram Bot API has its own flood-control 429s; same philosophy as OpenAI, shorter cap. */
const telegram = proxyActivities<typeof activities>({
  startToCloseTimeout: '15 seconds',
  retry: {
    initialInterval: '2 seconds',
    backoffCoefficient: 2,
    maximumInterval: '60 seconds',
    maximumAttempts: 6,
    nonRetryableErrorTypes: ['TelegramBadRequestError', 'TelegramMissingChatId', 'TelegramMisconfigured'],
  },
});

// =============================================================================
// DailyNudgeCronWorkflow — the fan-out entry point
// =============================================================================

const DEFAULT_BATCH_SIZE = 100;

export async function DailyNudgeCronWorkflow(
  input: DailyNudgeCronWorkflowInput = {},
): Promise<DailyNudgeRunTotals> {
  const cursor = input.cursor ?? 0;
  const batchSize = input.batchSize ?? DEFAULT_BATCH_SIZE;
  const totals: DailyNudgeRunTotals = input.totalsSoFar ?? { scanned: 0, childrenStarted: 0 };

  // Only ever pull `batchSize` customer_ids into memory — never the full table.
  const page = await db.getEligibleCustomerIdsPage({ cursor, limit: batchSize });

  // Fan out: one child workflow per customer_id. parentClosePolicy ABANDON
  // means this cron workflow does NOT block waiting for each child to finish
  // (which would otherwise force this workflow to stay open, and its history
  // to grow, for as long as the slowest of thousands of children takes).
  // startChild only awaits the child being *accepted* by the server, not its
  // result, so fan-out for a whole batch is fast and the per-execution
  // history cost is bounded to `batchSize` child-start events.
  await Promise.all(
    page.ids.map((customerId) =>
      startChild(IndividualUserNudgeWorkflow, {
        workflowId: `nudge-${customerId}-${dateStampForId()}`,
        args: [{ customer_id: customerId }],
        parentClosePolicy: ParentClosePolicy.ABANDON,
      }),
    ),
  );

  totals.scanned += page.ids.length;
  totals.childrenStarted += page.ids.length;

  if (!page.done) {
    // Hand off to a brand-new Workflow Execution before history grows
    // unbounded across a customer base of "thousands" — this is what makes
    // the Cron Workflow itself OOM/history-safe regardless of population size.
    await continueAsNew<typeof DailyNudgeCronWorkflow>({
      cursor: page.nextCursor,
      batchSize,
      totalsSoFar: totals,
    });
  }

  return totals;
}

/**
 * Deterministic-enough id suffix for child workflowId de-duplication within a
 * single cron day. Uses only workflow-safe inputs (no Math.random / Date.now
 * inside workflow code) — derived from the deterministic cursor-based
 * continueAsNew chain via closure over `Date.now()` at workflow-task
 * execution time is intentionally avoided; instead we rely on Temporal's
 * deterministic clock substitute.
 */
function dateStampForId(): string {
  // `Date.now()` is patched by the Temporal workflow runtime to be
  // deterministic on replay (it returns the time of the current workflow
  // task), so it is safe to use here purely for ID readability/uniqueness.
  return new Date().toISOString().slice(0, 10);
}

// =============================================================================
// IndividualUserNudgeWorkflow — one customer, fully isolated
// =============================================================================

export async function IndividualUserNudgeWorkflow(
  input: IndividualUserNudgeWorkflowInput,
): Promise<IndividualUserNudgeWorkflowResult> {
  const { customer_id } = input;

  // ---- Gates 1 & 2: consent + 72h frequency cap --------------------------
  // Replaces "Consent & Frequency Gate (DeepSeek)". On failure, exit
  // gracefully — no error, no message, no retry storm.
  const gate = await db.checkFrequencyAndConsentGate(customer_id);
  if (!gate.allowed) {
    return {
      customer_id,
      sent: false,
      skip_reason: gate.reason ?? NudgeSkipReason.FREQUENCY_CAPPED,
    };
  }

  // ---- Data Aggregation: balance, loan history, idle cash -----------------
  const snapshot = await db.getCustomerFinancialSnapshot(customer_id);
  if (!snapshot) {
    return { customer_id, sent: false, skip_reason: NudgeSkipReason.NO_TRIGGER };
  }

  // ---- Deterministic rule engine (pure — no I/O, runs directly in-workflow) -
  const candidate = evaluateNudgeIntent(snapshot);
  if (!candidate) {
    // "No trigger? No message. No spam." — exact behavior of the legacy node.
    return { customer_id, sent: false, skip_reason: NudgeSkipReason.NO_TRIGGER };
  }
  if (!candidate.telegram_chat_id) {
    return {
      customer_id,
      sent: false,
      nudge_intent: candidate.nudge_intent,
      skip_reason: NudgeSkipReason.MISSING_CHAT_ID,
    };
  }

  // ---- LLM personalization (isolated Activity, 429-resilient policy) ------
  const llmResponse = await llm.generateNudgeMessage({
    nudge_intent: candidate.nudge_intent,
    first_name: candidate.first_name,
    context_payload: candidate.context_payload,
  });

  // ---- Build Telegram payload with context-aware inline keyboard (pure) ---
  const telegramPayload = buildTelegramPayload(candidate, llmResponse.text);

  // ---- Dispatch -------------------------------------------------------------
  await telegram.dispatchTelegramNudge(telegramPayload);

  // ---- Persist frequency-cap state so the next run respects 72h -----------
  await db.recordNudgeSent(customer_id);

  return { customer_id, sent: true, nudge_intent: candidate.nudge_intent };
}

// =============================================================================
// Pure, deterministic helpers — safe to run directly in Workflow code because
// they perform no I/O, no randomness, and no wall-clock reads.
// =============================================================================

const SAVINGS_NUDGE_BALANCE_THRESHOLD = 5_000_000;
const SAVINGS_NUDGE_IDLE_DAYS_THRESHOLD = 30;
const TELEGRAM_CALLBACK_DATA_MAX_LENGTH = 64; // Telegram Bot API hard limit

/**
 * Equivalent to the legacy "Deterministic Nudge Engine" code node. Strictly
 * rule-based, evaluated in priority order: low-balance warning, then loan
 * renewal, then idle-cash savings nudge. Returns null when no rule fires.
 */
export function evaluateNudgeIntent(c: CustomerFinancialSnapshot): NudgeCandidate | null {
  // Rule A — low balance ahead of an upcoming autopay.
  if (c.upcoming_autopay && c.current_balance < c.upcoming_autopay.amount) {
    return {
      customer_id: c.customer_id,
      telegram_chat_id: c.telegram_chat_id,
      first_name: c.first_name,
      nudge_intent: NudgeIntent.LOW_BALANCE_WARNING,
      context_payload: {
        balance: c.current_balance,
        bill_amount: c.upcoming_autopay.amount,
        due_date: c.upcoming_autopay.due_date,
        merchant: c.upcoming_autopay.merchant,
      },
    };
  }

  // Rule B — loan approaching maturity with a good repayment history.
  if (c.loan && c.loan.repayment_history === 'GOOD') {
    return {
      customer_id: c.customer_id,
      telegram_chat_id: c.telegram_chat_id,
      first_name: c.first_name,
      nudge_intent: NudgeIntent.LOAN_RENEWAL,
      context_payload: {
        loan_id: c.loan.loan_id,
        maturity_date: c.loan.maturity_date,
        remaining_balance: c.loan.remaining_balance,
      },
    };
  }

  // Rule C — large idle balance sitting unused.
  if (c.current_balance >= SAVINGS_NUDGE_BALANCE_THRESHOLD && c.idle_cash_days >= SAVINGS_NUDGE_IDLE_DAYS_THRESHOLD) {
    return {
      customer_id: c.customer_id,
      telegram_chat_id: c.telegram_chat_id,
      first_name: c.first_name,
      nudge_intent: NudgeIntent.SAVINGS_NUDGE,
      context_payload: {
        balance: c.current_balance,
        idle_days: c.idle_cash_days,
      },
    };
  }

  return null;
}

/**
 * Equivalent to the legacy "Outbound Dispatcher Builder" node: builds the
 * Telegram sendMessage payload, attaching a context-aware inline keyboard
 * whose callback_data round-trips to the main bot webhook.
 */
export function buildTelegramPayload(candidate: NudgeCandidate, text: string): TelegramSendMessagePayload {
  const payload: TelegramSendMessagePayload = {
    chat_id: candidate.telegram_chat_id as string,
    text,
    parse_mode: 'HTML',
  };

  const button = buildInlineButton(candidate.nudge_intent, candidate.customer_id);
  if (button) {
    payload.reply_markup = { inline_keyboard: [[button]] };
  }

  return payload;
}

function buildInlineButton(intent: NudgeIntent, customerId: string): TelegramInlineKeyboardButton | null {
  let button: TelegramInlineKeyboardButton;

  switch (intent) {
    case NudgeIntent.LOW_BALANCE_WARNING:
      button = { text: "\uD83D\uDCB3 Hisobni to'ldirish (Top Up)", callback_data: `INTENT_TOPUP|${customerId}` };
      break;
    case NudgeIntent.LOAN_RENEWAL:
      button = { text: '\uD83D\uDD04 Qayta moliyalashtirish (Renew)', callback_data: `INTENT_LOAN|${customerId}` };
      break;
    case NudgeIntent.SAVINGS_NUDGE:
      button = { text: '\uD83D\uDCB0 Omonat ochish (Open Deposit)', callback_data: `INTENT_DEPOSIT|${customerId}` };
      break;
    default:
      return null;
  }

  // Fail safe rather than fail silent: never ship a button Telegram will reject.
  if (button.callback_data.length > TELEGRAM_CALLBACK_DATA_MAX_LENGTH) {
    return null;
  }

  return button;
}