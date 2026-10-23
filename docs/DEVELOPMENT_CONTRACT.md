# Implementation contract

Read `TECH_SPEC.md` first. Shared files must not be overwritten by other owners. All times are integer UTC milliseconds; IDs are `crypto.randomUUID()`, Telegram IDs are numeric. Bound parameters only, no untrusted SQL interpolation. No dependencies at runtime.

## Ownership

- Persistence: `migrations/`, `src/db.ts`, `src/store.ts`, `tests/helpers/`, `tests/store.test.ts`.
- Bot interface: `src/bot.ts`, optional `src/forms.ts`, `src/keyboards.ts`, `tests/bot.test.ts`.
- Scheduling: `src/reminders.ts`, `src/time.ts`, `tests/reminders.test.ts`, `tests/time.test.ts`.
- Main agent: shared types, Telegram client, Worker entrypoint, tooling, deployment scripts, docs, integration and review.

## SQL schema (exact column names)

- `users`: id INTEGER PK, username TEXT NULL, display_name TEXT, role TEXT ('member'/'org'), subscribed INTEGER DEFAULT 0, dm_active INTEGER DEFAULT 1, created_at INTEGER, updated_at INTEGER.
- `items`: id TEXT PK, kind TEXT ('event'/'post'), title TEXT, start_at INTEGER NULL, visibility TEXT ('public'/'private'), status TEXT ('idea'/'development'/'ready'/'done'/'cancelled'), location TEXT NULL, post_url TEXT NULL, registration_deadline INTEGER NULL, published INTEGER DEFAULT 0, created_by INTEGER, revision INTEGER DEFAULT 1, created_at INTEGER, updated_at INTEGER.
- `item_assignees`: item_id TEXT, user_id INTEGER, composite PK.
- `tasks`: id TEXT PK, item_id TEXT, parent_id TEXT NULL (one nesting level), title TEXT, due_at INTEGER NULL, status TEXT ('open'/'done'), created_by INTEGER, revision INTEGER DEFAULT 1, created_at INTEGER, updated_at INTEGER.
- `task_assignees`: task_id TEXT, user_id INTEGER, composite PK.
- `sessions`: user_id INTEGER PK, flow TEXT, step TEXT, data TEXT (JSON), expires_at INTEGER, updated_at INTEGER.
- `groups`: chat_id INTEGER PK, title TEXT, enabled INTEGER DEFAULT 1, org_only INTEGER DEFAULT 0, updated_at INTEGER.
- `settings`: key TEXT PK, value TEXT. Values are plain text. Keys: org_chat_id, org_thread_id, suggestions_chat_id, suggestions_thread_id. Empty thread value means no topic.
- `suggestions`: id TEXT PK, user_id INTEGER, chat_id INTEGER, message_id INTEGER, body_text TEXT NULL, created_at INTEGER.
- `notifications`: id TEXT PK, dedupe_key TEXT UNIQUE, kind TEXT ('event'/'post'/'task'/'registration'/'suggestion'), item_id TEXT NULL, task_id TEXT NULL, item_revision INTEGER NULL, task_revision INTEGER NULL, recipient_user_id INTEGER NULL, chat_id INTEGER, thread_id INTEGER NULL, scheduled_at INTEGER, expires_at INTEGER NULL, payload TEXT (JSON), state TEXT ('pending'/'sending'/'sent'/'failed'/'cancelled'), attempts INTEGER DEFAULT 0, next_attempt_at INTEGER, locked_until INTEGER NULL, sent_at INTEGER NULL, telegram_message_id INTEGER NULL, last_error TEXT NULL, created_at INTEGER.
- `telegram_updates`: update_id INTEGER PK, state TEXT ('processing'/'done'), lease_until INTEGER, attempts INTEGER DEFAULT 1, received_at INTEGER.

Add indexes on scheduling, active items, username, open tasks and foreign keys with suitable cascades. Sessions expire after 24h. Notification payload: `{method: 'sendMessage' | 'copyMessage', body: {...}}`. Never put API tokens into payloads.

## Shared API

`Database` in `src/db.ts` wraps D1:

```
constructor(binding: D1Database)
get<T>(sql: string, params?: DBValue[]): Promise<T | null>
all<T>(sql: string, params?: DBValue[]): Promise<T[]>
run(sql: string, params?: DBValue[]): Promise<D1Result>
batch(statements: {sql: string, params?: DBValue[]}[]): Promise<D1Result[]>
```

`src/store.ts` exports:

```
upsertUser(db, telegramUser, bootstrapOrgIds: number[], now: number): Promise<UserRow>
getUser(db, id: number): Promise<UserRow | null>
getSetting(db, key: string): Promise<string | null>
setSetting(db, key: string, value: string): Promise<void>
getSession(db, userId: number, now: number): Promise<SessionRow | null>
putSession(db, userId: number, flow: string, step: string, data: unknown, now: number): Promise<void>
clearSession(db, userId: number): Promise<void>
getItemAssignees(db, itemId: string): Promise<UserRow[]>
getTaskAssignees(db, taskId: string): Promise<UserRow[]>
claimTelegramUpdate(db, updateId: number, now: number): Promise<'claimed' | 'done' | 'busy'>
finishTelegramUpdate(db, updateId: number, now: number): Promise<void>
releaseTelegramUpdate(db, updateId: number): Promise<void>
```

Bot exports `handleUpdate(update: TelegramUpdate, env: Env, db: Database, telegram: TelegramApi, now?: number): Promise<void>`.

Scheduler exports `runReminders(env: Env, db: Database, telegram: TelegramApi, now?: number): Promise<{queued: number; sent: number; failed: number}>`.

Time exports `parseDateTime(input: string, timeZone?: string): number | null`, `formatDateTime(value: number | null, timeZone?: string): string`, `HOUR`, `DAY`. Input Russian `ДД.ММ.ГГГГ ЧЧ:ММ`; default Europe/Moscow. Invalid calendar dates must be rejected, not silently normalized.

Telegram client exports `TelegramApi.call<T>(method, body)`, `.sendMessage(chatId, text, extra?)`, `.answerCallbackQuery(id, text?)`, `.copyMessage(chatId, fromChatId, messageId, extra?)`. The constructor takes token and optional fetch implementation. Errors are `TelegramApiError` with `errorCode`, `retryAfter?: number`, `description`; no token/URL leakage.

Shared types are in `src/types.ts`. The bot UI can use SQL through Database. Every organizer mutation and internal read must re-check live role. Event edits increment `items.revision`; task edits increment `tasks.revision`; changing assignments also increments the associated revision. Removal of the last active organizer is refused. Configuring an org/suggestions chat marks that group org_only=1. Never send broadcast into channels or configured internal groups.

## Queue rules

Persist future jobs; unique keys include entity revisions, recipient and offset. Compare revision/visibility/status/subscription again before delivery. Atomically lease each batch; honour retry_after; bound batch size (default 15) and attempt count. Stop DM sends after bot-blocked errors and disable removed groups. Do not leak internal task/event data into public broadcasts. Use latest missed reminder only on recovery, with remaining older reminders cancelled. No reminder before the entity was created, or after its anchor time has passed. Delivery is at-least-once with the ambiguous Telegram success caveat in the spec.

Suggestions: insert suggestion and a notification (kind=suggestion) atomically. Payload copyMessage uses source chat/message and an inline author button, or a safe descriptive message. Topic comes from suggestions settings. UI acknowledges queued submission; actual delivery is handled by cron.

## Local verification

Toolchain: bundled Node 24.19.0. Main agent installs TypeScript, tsx, Wrangler and Workers types. `node --import tsx --test tests/*.test.ts` executes tests. Persistence agent supplies a SQLite-backed D1 test helper (Node `node:sqlite`) so all tests can use actual SQL without live credentials; main agent also runs genuine local D1 migrations and Worker dry-run.
