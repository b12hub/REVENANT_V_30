# REVENANT V31 — F5 (Proactive Nudge & Engagement Service)

Temporal-based replacement for the `REVENANT V31 - F5 (Proactive Nudges)` n8n workflow.

## Node → code mapping

| n8n node | Replacement |
|---|---|
| Schedule Trigger (`triggerAtHour: 9`) | Temporal **Schedule** (`src/schedule-cron.ts`) starting `DailyNudgeCronWorkflow` daily at 09:00 |
| Customer State Hydrator (Mock DB) | `activities.getCustomerFinancialSnapshot` — real Postgres query |
| Deterministic Nudge Engine | `workflows.evaluateNudgeIntent` — same 3 rules, pure function run directly in Workflow code (no I/O, safe for replay) |
| Consent & Frequency Gate (DeepSeek) | `activities.checkFrequencyAndConsentGate` — real query against `user_preferences`, fails closed |
| Basic LLM Chain + OpenAI Chat Model | `activities.generateNudgeMessage` — direct OpenAI SDK call, same system prompt and intent semantics |
| Outbound Dispatcher Builder | `workflows.buildTelegramPayload` / `buildInlineButton` — same intent → button → `callback_data` mapping, same 64-byte guard |
| Send a text message | `activities.dispatchTelegramNudge` — real Telegram Bot API call |

## Why two workflows

- **`DailyNudgeCronWorkflow`** never loads the customer base into memory. It asks Postgres for one bounded page of `customer_id`s (`batchSize`, default 100), starts one child workflow per id with `parentClosePolicy: ABANDON` (so it doesn't block on completion), then calls `continueAsNew` to fetch the next page in a brand-new Workflow Execution. This is what keeps both memory use and this workflow's own Event History bounded no matter how many customers exist.
- **`IndividualUserNudgeWorkflow`** does everything for exactly one customer: gate → aggregate → rule engine → LLM → dispatch → record. Any gate failure is a graceful, error-free exit (`skip_reason` in the result), never a thrown failure.

## Retry policy design (`workflows.ts`)

Three separate `proxyActivities` groups, each tuned to its dependency:

- **`db`** — Postgres reads/writes. Short timeouts, fast retries (≤30s cap).
- **`llm`** — the OpenAI call. `maximumInterval: '2 minutes'`, `maximumAttempts: 8`. A 429 here means "the token bucket is empty," not "this request is broken" — the long cap lets Temporal wait out a rate-limit window instead of burning through retries or dropping the nudge. `OpenAIInvalidRequestError` (4xx other than 429) is marked non-retryable since retrying a malformed request never helps.
- **`telegram`** — Telegram's own flood-control 429s get the same treatment with a shorter cap; bad payloads / missing chat / missing token are non-retryable.

`activities.ts` classifies errors via `ApplicationFailure.retryable(...)` / `.nonRetryable(...)` based on HTTP status codes, so the policy above is what actually controls timing.

## Schema assumptions

The SQL in `activities.ts` assumes (adjust to your real schema):

- `customers(customer_id, telegram_chat_id, first_name, is_active)`
- `accounts(customer_id, current_balance, idle_cash_days)`
- `autopay_schedule(customer_id, amount, due_date, merchant, status)`
- `loans(customer_id, loan_id, remaining_balance, maturity_date, repayment_history, status)`
- `user_preferences(customer_id, opt_in_marketing, last_nudge_sent_at)`

## Environment variables

| Var | Used by |
|---|---|
| `DATABASE_URL` | Postgres connection string (`pg.Pool`) |
| `OPENAI_API_KEY` | OpenAI SDK |
| `OPENAI_MODEL` | optional, defaults to `gpt-4o-mini` (matches the original `lmChatOpenAi` node) |
| `TELEGRAM_BOT_TOKEN` | Telegram Bot API |
| `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE` | optional, used by `schedule-cron.ts` |

## Running it

```bash
npm install
npm run build      # tsc type-check / compile
npm run worker      # starts the Temporal Worker (src/worker.ts)
npm run schedule     # one-time: registers the daily 09:00 Schedule (src/schedule-cron.ts)
```

`worker.ts` and `schedule-cron.ts` are bootstrap conveniences, not part of the three required deliverables (`types.ts`, `activities.ts`, `workflows.ts`), but are included so the service runs end-to-end against a real Temporal server.