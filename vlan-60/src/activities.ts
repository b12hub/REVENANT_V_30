// =============================================================================
// REVENANT V31 — F5 (Proactive Nudge & Engagement Service)
// activities.ts
//
// All I/O — Postgres, OpenAI, Telegram — lives here, isolated from Workflow
// code so it can be retried, mocked, and scaled across Workers independently.
//
// Error handling convention:
//   - Transient failures (network blips, 5xx, 429s) -> ApplicationFailure.retryable
//   - Permanent failures (bad input, 4xx auth/validation) -> ApplicationFailure.nonRetryable
//   Temporal's retry policy (configured at the call site in workflows.ts) then
//   decides timing/backoff; nonRetryable() short-circuits that regardless of
//   the configured policy.
// =============================================================================

import { Pool } from 'pg';
import { ApplicationFailure } from '@temporalio/activity';
import OpenAI from 'openai';
import type {
  CustomerFinancialSnapshot,
  UserPreferencesRow,
  FrequencyGateResult,
  LlmNudgeRequest,
  LlmNudgeResponse,
  TelegramSendMessagePayload,
  TelegramDispatchResult,
  EligibleCustomerPage,
  EligibleCustomerPageArgs,
} from './types';
import { NudgeSkipReason } from './types';

// -----------------------------------------------------------------------------
// Shared clients — instantiated lazily, reused across activity invocations on
// the same Worker process (do NOT create a new Pool/client per call).
// -----------------------------------------------------------------------------

let pgPool: Pool | undefined;
function getPool(): Pool {
  if (!pgPool) {
    pgPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30_000,
    });
  }
  return pgPool;
}

let openaiClient: OpenAI | undefined;
function getOpenAI(): OpenAI {
  if (!openaiClient) {
    openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return openaiClient;
}

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? '';
const FREQUENCY_CAP_HOURS = 72;
const LLM_MODEL = process.env.OPENAI_MODEL ?? 'gpt-4o-mini';

// =============================================================================
// 1. Fan-out source — paginated eligible-customer query
//
// This is the ONLY query that runs against the full customer base, and it
// never returns more than `limit` ids at a time. The Cron Workflow pages
// through it via continueAsNew so neither this activity nor the workflow ever
// materializes "thousands of user records" in memory at once.
// =============================================================================

export async function getEligibleCustomerIdsPage(
  args: EligibleCustomerPageArgs,
): Promise<EligibleCustomerPage> {
  const { cursor, limit } = args;
  const pool = getPool();

  try {
    const { rows } = await pool.query<{ customer_id: string }>(
      `SELECT customer_id
         FROM customers
        WHERE is_active = true
        ORDER BY customer_id
        OFFSET $1
        LIMIT $2`,
      [cursor, limit],
    );

    const ids = rows.map((r) => r.customer_id);
    return {
      ids,
      nextCursor: cursor + ids.length,
      done: ids.length < limit, // short page => no more rows after this one
    };
  } catch (err) {
    throw ApplicationFailure.retryable(
      `Failed to fetch eligible customer page at cursor=${cursor}: ${describe(err)}`,
      'PostgresQueryError',
    );
  }
}

// =============================================================================
// 2. Consent & 72-hour Frequency Gate
//
// Replaces the "Consent & Frequency Gate (DeepSeek)" code node with a real,
// testable query against `user_preferences`. Fails CLOSED: any ambiguity
// (missing row, missing consent) results in no message being sent.
// =============================================================================

export async function checkFrequencyAndConsentGate(customerId: string): Promise<FrequencyGateResult> {
  const pool = getPool();

  let row: UserPreferencesRow | undefined;
  try {
    const { rows } = await pool.query<UserPreferencesRow>(
      `SELECT customer_id, opt_in_marketing, last_nudge_sent_at
         FROM user_preferences
        WHERE customer_id = $1`,
      [customerId],
    );
    row = rows[0];
  } catch (err) {
    throw ApplicationFailure.retryable(
      `Failed to read user_preferences for ${customerId}: ${describe(err)}`,
      'PostgresQueryError',
    );
  }

  // No preferences row, or explicit opt-out -> fail closed, never spam.
  if (!row || !row.opt_in_marketing) {
    return { allowed: false, reason: NudgeSkipReason.CONSENT_NOT_GRANTED, hours_since_last_nudge: null };
  }

  if (row.last_nudge_sent_at) {
    const hoursSinceLastNudge = (Date.now() - new Date(row.last_nudge_sent_at).getTime()) / (60 * 60 * 1000);

    if (hoursSinceLastNudge < FREQUENCY_CAP_HOURS) {
      return {
        allowed: false,
        reason: NudgeSkipReason.FREQUENCY_CAPPED,
        hours_since_last_nudge: hoursSinceLastNudge,
      };
    }

    return { allowed: true, reason: null, hours_since_last_nudge: hoursSinceLastNudge };
  }

  return { allowed: true, reason: null, hours_since_last_nudge: null };
}

/**
 * Persist that a nudge was just sent, so the next run's frequency gate sees
 * it. Upserts because a customer may not have a `user_preferences` row yet
 * (e.g. first-ever nudge) — in that case the row is created already opted in,
 * mirroring the assumption that we only reach this point after gate #1 passed.
 */
export async function recordNudgeSent(customerId: string): Promise<void> {
  const pool = getPool();
  try {
    await pool.query(
      `INSERT INTO user_preferences (customer_id, opt_in_marketing, last_nudge_sent_at)
       VALUES ($1, true, NOW())
       ON CONFLICT (customer_id)
       DO UPDATE SET last_nudge_sent_at = NOW()`,
      [customerId],
    );
  } catch (err) {
    throw ApplicationFailure.retryable(
      `Failed to record nudge dispatch for ${customerId}: ${describe(err)}`,
      'PostgresQueryError',
    );
  }
}

// =============================================================================
// 3. Data Aggregation — balance, loan history, idle cash
//
// Replaces the "Customer State Hydrator (Mock DB)" node with a real query.
// Joins are illustrative; adjust table/column names to your actual schema.
// =============================================================================

interface SnapshotRow {
  customer_id: string;
  telegram_chat_id: string | null;
  first_name: string;
  current_balance: string | number;
  autopay_amount: string | number | null;
  autopay_due_date: string | null;
  autopay_merchant: string | null;
  loan_id: string | null;
  loan_remaining_balance: string | number | null;
  maturity_date: string | null;
  repayment_history: string | null;
  idle_cash_days: string | number | null;
}

export async function getCustomerFinancialSnapshot(
  customerId: string,
): Promise<CustomerFinancialSnapshot | null> {
  const pool = getPool();

  try {
    const { rows } = await pool.query<SnapshotRow>(
      `SELECT
          c.customer_id,
          c.telegram_chat_id,
          c.first_name,
          a.current_balance,
          ap.amount            AS autopay_amount,
          ap.due_date          AS autopay_due_date,
          ap.merchant          AS autopay_merchant,
          l.loan_id,
          l.remaining_balance  AS loan_remaining_balance,
          l.maturity_date,
          l.repayment_history,
          a.idle_cash_days
        FROM customers c
        JOIN accounts a
          ON a.customer_id = c.customer_id
        LEFT JOIN autopay_schedule ap
          ON ap.customer_id = c.customer_id AND ap.status = 'PENDING'
        LEFT JOIN loans l
          ON l.customer_id = c.customer_id AND l.status = 'ACTIVE'
       WHERE c.customer_id = $1
       LIMIT 1`,
      [customerId],
    );

    const row = rows[0];
    if (!row) return null;

    return {
      customer_id: row.customer_id,
      telegram_chat_id: row.telegram_chat_id ?? null,
      first_name: row.first_name,
      current_balance: Number(row.current_balance),
      upcoming_autopay:
        row.autopay_amount != null
          ? {
              amount: Number(row.autopay_amount),
              due_date: row.autopay_due_date as string,
              merchant: row.autopay_merchant as string,
            }
          : null,
      loan: row.loan_id
        ? {
            loan_id: row.loan_id,
            remaining_balance: Number(row.loan_remaining_balance),
            maturity_date: row.maturity_date as string,
            repayment_history: row.repayment_history as string,
          }
        : null,
      idle_cash_days: Number(row.idle_cash_days ?? 0),
    };
  } catch (err) {
    throw ApplicationFailure.retryable(
      `Failed to aggregate financial snapshot for ${customerId}: ${describe(err)}`,
      'PostgresQueryError',
    );
  }
}

// =============================================================================
// 4. LLM personalization — isolated Activity, tuned for OpenAI 429s
//
// Replaces the LangChain "Basic LLM Chain" + "OpenAI Chat Model" nodes.
// The actual retry timing (generous maximumInterval so the token bucket can
// refill) is configured on the Activity proxy in workflows.ts — this function
// only needs to correctly CLASSIFY errors as retryable vs not.
// =============================================================================

const SYSTEM_PROMPT = `You are REVENANT V31, an empathetic financial wellness assistant for a bank in Uzbekistan. You are NOT allowed to calculate money, invent products, make promises, or create financial advice outside the provided context_payload. You only perform natural-language personalization.

Rules:
- Write in natural Uzbek.
- Tone should feel supportive and caring, like a trusted financial partner.
- Keep messages under 80 words.
- Never sound robotic.
- Never mention AI.
- Never invent numbers or dates.
- Use only values found inside context_payload.
- Do not recommend products that are not implied by the nudge_intent.

Intent meanings:
- LOW_BALANCE_WARNING: Warn that an upcoming automatic payment may fail because balance is lower than the required amount.
- LOAN_RENEWAL: Congratulate the customer for good repayment history and gently remind them that the loan maturity date is approaching.
- SAVINGS_NUDGE: Suggest that idle money could be placed into a savings/deposit product.

Output only plain Telegram-ready Uzbek text.`;

export async function generateNudgeMessage(request: LlmNudgeRequest): Promise<LlmNudgeResponse> {
  const client = getOpenAI();

  const userMessage =
    'Please generate the message for this customer. ' +
    `Nudge Intent: ${request.nudge_intent} | ` +
    `First Name: ${request.first_name} | ` +
    `Context Payload: ${JSON.stringify(request.context_payload)}`;

  try {
    const completion = await client.chat.completions.create({
      model: LLM_MODEL,
      temperature: 0.6,
      max_tokens: 220,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userMessage },
      ],
    });

    const text = completion.choices[0]?.message?.content?.trim();
    if (!text) {
      throw ApplicationFailure.retryable('OpenAI returned an empty completion', 'OpenAIEmptyResponse');
    }

    return { text, model: LLM_MODEL };
  } catch (err) {
    throw classifyOpenAiError(err);
  }
}

function classifyOpenAiError(err: unknown): never {
  if (err instanceof ApplicationFailure) {
    throw err; // already classified above (empty completion case)
  }

  // The official `openai` SDK throws APIError subclasses carrying `.status`.
  const status = (err as { status?: number } | undefined)?.status;

  if (status === 429) {
    // Rate limited. This is exactly what the generous maximumInterval on the
    // LLM activity's retry policy (see workflows.ts) is designed to absorb —
    // we retry rather than drop the nudge silently.
    throw ApplicationFailure.retryable(`OpenAI rate limit (429): ${describe(err)}`, 'OpenAIRateLimitError');
  }
  if (status === 400 || status === 401 || status === 403 || status === 404) {
    // Malformed request, bad credentials, or unknown model — retrying never helps.
    throw ApplicationFailure.nonRetryable(
      `OpenAI request rejected (${status}): ${describe(err)}`,
      'OpenAIInvalidRequestError',
    );
  }
  // 5xx, timeouts, network errors, etc — treat as transient.
  throw ApplicationFailure.retryable(`OpenAI call failed: ${describe(err)}`, 'OpenAITransientError');
}

// =============================================================================
// 5. Telegram dispatch — sends the inline-keyboard nudge
//
// Replaces "Outbound Dispatcher Builder" (payload shape only — the keyboard
// itself is built deterministically in workflows.ts) + "Send a text message".
// =============================================================================

export async function dispatchTelegramNudge(
  payload: TelegramSendMessagePayload,
): Promise<TelegramDispatchResult> {
  if (!payload.chat_id) {
    throw ApplicationFailure.nonRetryable('Missing chat_id — cannot dispatch nudge', 'TelegramMissingChatId');
  }
  if (!TELEGRAM_BOT_TOKEN) {
    throw ApplicationFailure.nonRetryable('TELEGRAM_BOT_TOKEN is not configured', 'TelegramMisconfigured');
  }

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    throw ApplicationFailure.retryable(`Network error calling Telegram API: ${describe(err)}`, 'TelegramNetworkError');
  }

  const body: any = await response.json().catch(() => ({}));

  if (response.status === 429) {
    // Telegram's own flood-control limit. Same philosophy as the OpenAI 429
    // path: retry with backoff (configured in workflows.ts) instead of
    // dropping the message.
    const retryAfter = body?.parameters?.retry_after;
    throw ApplicationFailure.retryable(
      `Telegram rate limit (429)${retryAfter ? `, retry_after=${retryAfter}s` : ''}`,
      'TelegramRateLimitError',
    );
  }

  if (response.status === 400 || response.status === 403) {
    // e.g. chat not found, bot blocked by user, malformed markup — permanent for this message.
    throw ApplicationFailure.nonRetryable(
      `Telegram rejected payload (${response.status}): ${JSON.stringify(body)}`,
      'TelegramBadRequestError',
    );
  }

  if (!response.ok) {
    throw ApplicationFailure.retryable(
      `Telegram API error (${response.status}): ${JSON.stringify(body)}`,
      'TelegramTransientError',
    );
  }

  return { ok: true, telegram_message_id: body?.result?.message_id };
}

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}