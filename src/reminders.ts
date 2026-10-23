import type { Database } from './db.js';
import { TelegramApiError, type TelegramApi } from './telegram.js';
import type { DBValue, Env, GroupRow, ItemRow, NotificationPayload, NotificationRow, TaskRow, UserRow } from './types.js';
import { formatDateTime, HOUR } from './time.js';

const OFFSETS = [168, 72, 24];
const MAX_ATTEMPTS = 8;
const LEASE_MS = 5 * 60 * 1000;
type Settings = Record<string, string>;
type Assignment = UserRow & { entity_id: string };
type Recipient = { chatId: number; userId: number | null; threadId: number | null; after?: number };
type EnqueueResult = { queued: number; queries: number };
type DeliveryOrder = Pick<NotificationRow, 'kind' | 'scheduled_at' | 'created_at' | 'id'>;

function compareDelivery(a: DeliveryOrder, b: DeliveryOrder): number {
  const priority = (job: DeliveryOrder) => job.kind === 'reply' ? 0 : job.kind === 'suggestion' ? 1 : 2;
  return priority(a) - priority(b)
    || (priority(a) < 2 ? a.scheduled_at - b.scheduled_at : b.scheduled_at - a.scheduled_at)
    || a.created_at - b.created_at || a.id.localeCompare(b.id);
}

const INSERT = `INSERT OR IGNORE INTO notifications
  (id,dedupe_key,kind,item_id,task_id,item_revision,task_revision,recipient_user_id,
   chat_id,thread_id,scheduled_at,expires_at,payload,state,attempts,next_attempt_at,created_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',0,?,?)`;

function settingNumber(settings: Settings, key: string): number | null {
  const text = settings[key];
  if (!text?.trim()) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) && value !== 0 ? value : null;
}

async function readSettings(db: Database): Promise<Settings> {
  const rows = await db.all<{ key: string; value: string }>('SELECT key,value FROM settings');
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

function names(users: UserRow[]): string {
  return users.map((user) => user.username ? `@${user.username}` : user.display_name).join(', ').slice(0, 2000);
}

function internalRecipient(settings: Settings, groups: GroupRow[]): Recipient | null {
  const chatId = settingNumber(settings, 'org_chat_id');
  if (chatId === null || chatId >= 0 || groups.some((group) => group.chat_id === chatId && !group.enabled)) return null;
  return { chatId, userId: null, threadId: settingNumber(settings, 'org_thread_id') };
}

function recipients(assignees: UserRow[], group: Recipient | null): Recipient[] {
  if (assignees.length === 0) return [];
  return [
    ...assignees.filter((user) => user.dm_active).map((user) => ({ chatId: user.id, userId: user.id, threadId: null })),
    ...(group ? [group] : []),
  ];
}

/** Generate durable jobs. Entity timestamps, rather than cron uptime, prevent retroactive new-card reminders. */
async function enqueue(env: Env, db: Database, now: number): Promise<EnqueueResult> {
  const [items, tasks, itemAssignments, taskAssignments, users, groups, settings, existingJobs] = await Promise.all([
    db.all<ItemRow>("SELECT * FROM items WHERE status NOT IN ('done','cancelled')"),
    db.all<TaskRow>("SELECT t.* FROM tasks t JOIN items i ON i.id=t.item_id WHERE t.status='open' AND i.status NOT IN ('done','cancelled')"),
    db.all<Assignment>("SELECT u.*,a.item_id AS entity_id FROM item_assignees a JOIN users u ON u.id=a.user_id WHERE u.role='org'"),
    db.all<Assignment>("SELECT u.*,a.task_id AS entity_id FROM task_assignees a JOIN users u ON u.id=a.user_id WHERE u.role='org'"),
    db.all<UserRow>('SELECT * FROM users WHERE subscribed=1 AND dm_active=1'),
    db.all<GroupRow>('SELECT * FROM groups'),
    readSettings(db),
    db.all<{ dedupe_key: string }>(`SELECT n.dedupe_key FROM notifications n
      JOIN items i ON i.id=n.item_id LEFT JOIN tasks t ON t.id=n.task_id
      WHERE n.kind NOT IN ('suggestion','reply') AND n.expires_at>? AND i.revision=n.item_revision
        AND i.status NOT IN ('done','cancelled')
        AND (n.kind!='task' OR (t.revision=n.task_revision AND t.status='open'))`, [now]),
  ]);
  const rows: DBValue[][] = [];
  const existingKeys = new Set(existingJobs.map((job) => job.dedupe_key));
  const itemMap = new Map(items.map((item) => [item.id, item]));
  const orgGroup = internalRecipient(settings, groups);
  const timeZone = env.TIMEZONE || 'Europe/Moscow';

  function add(item: ItemRow, task: TaskRow | null, kind: NotificationRow['kind'], anchor: number,
    hours: number[], after: number, targets: Recipient[], makeText: (offset: number) => string): void {
    if (anchor <= now) return;
    for (const offset of hours) {
      const scheduled = anchor - offset * HOUR;
      if (scheduled < after) continue;
      const text = makeText(offset);
      for (const target of targets) {
        if (target.after !== undefined && scheduled < target.after) continue;
        const key = [kind, item.id, item.revision, task?.id ?? '-', task?.revision ?? '-',
          target.userId === null ? 'group' : 'user', target.chatId, target.threadId ?? 0, anchor, offset].join(':');
        // Backfill large newly-created schedules across cron ticks instead of exhausting D1's free invocation budget.
        if (existingKeys.has(key) || rows.length >= 36) continue;
        existingKeys.add(key);
        const body: Record<string, unknown> = { chat_id: target.chatId, text, link_preview_options: { is_disabled: true } };
        if (target.threadId !== null) body.message_thread_id = target.threadId;
        if (kind === 'registration' && item.post_url) {
          body.reply_markup = { inline_keyboard: [[{ text: 'Пост и регистрация', url: item.post_url }]] };
        }
        const payload: NotificationPayload = { method: 'sendMessage', body };
        rows.push([crypto.randomUUID(), key, kind, item.id, task?.id ?? null,
          item.revision, task?.revision ?? null, target.userId, target.chatId, target.threadId,
          scheduled, anchor, JSON.stringify(payload), scheduled, now]);
      }
    }
  }

  for (const item of items) {
    const assignees = itemAssignments.filter((user) => user.entity_id === item.id);
    if (item.start_at !== null) {
      add(item, null, item.kind, item.start_at, OFFSETS, Math.max(item.created_at, item.updated_at), recipients(assignees, orgGroup),
        () => `Напоминание: ${item.kind === 'event' ? 'мероприятие' : 'публикация поста'}\n${item.title.slice(0, 300)}\n${formatDateTime(item.start_at, timeZone)}${item.location ? `\nМесто: ${item.location.slice(0, 300)}` : ''}\nОтветственные: ${names(assignees)}`);
    }
    if (item.kind === 'event' && item.visibility === 'public' && item.published && item.post_url && item.registration_deadline !== null) {
      const internalChats = [settingNumber(settings, 'org_chat_id'), settingNumber(settings, 'suggestions_chat_id')];
      const publicTargets: Recipient[] = [
        ...users.map((user) => ({ chatId: user.id, userId: user.id, threadId: null, after: user.updated_at })),
        ...groups.filter((group) => group.enabled && !group.org_only && group.chat_id < 0 && !internalChats.includes(group.chat_id))
          .map((group) => ({ chatId: group.chat_id, userId: null, threadId: null, after: group.updated_at })),
      ];
      add(item, null, 'registration', item.registration_deadline, [72, 24], Math.max(item.created_at, item.updated_at), publicTargets,
        () => `Напоминание о регистрации\n${item.title.slice(0, 300)}\nДо ${formatDateTime(item.registration_deadline, timeZone)}\n${item.post_url}`);
    }
  }
  for (const task of tasks) {
    const item = itemMap.get(task.item_id);
    if (!item) continue;
    const anchor = task.due_at ?? item.start_at;
    if (anchor === null) continue;
    const assignees = taskAssignments.filter((user) => user.entity_id === task.id);
    add(item, task, 'task', anchor, OFFSETS, Math.max(task.created_at, task.updated_at, item.updated_at), recipients(assignees, orgGroup),
      () => `Напоминание о задании\n${task.title.slice(0, 500)}\n${item.title.slice(0, 300)}\nСрок: ${formatDateTime(anchor, timeZone)}\nИсполнители: ${names(assignees)}`);
  }
  let queued = 0, queries = 8;
  const [header, rowSql] = INSERT.split('VALUES ');
  // D1 accepts at most 100 bound parameters: six rows use 90.
  for (let index = 0; index < rows.length; index += 6) {
    const chunk = rows.slice(index, index + 6);
    const result = await db.run(`${header}VALUES ${chunk.map(() => rowSql.trim()).join(',')}`, chunk.flat());
    queued += result.meta.changes || 0;
    queries++;
  }
  return { queued, queries };
}

async function cancelObsolete(db: Database, now: number): Promise<void> {
  await db.run(`UPDATE notifications SET state='cancelled',locked_until=NULL
    WHERE state IN ('pending','sending') AND ((kind='reply' AND expires_at<=?) OR (kind NOT IN ('suggestion','reply') AND (
      (expires_at IS NOT NULL AND expires_at<=?) OR NOT EXISTS (
        SELECT 1 FROM items i WHERE i.id=notifications.item_id AND i.revision=notifications.item_revision
          AND i.status NOT IN ('done','cancelled')
          AND (notifications.kind!='registration' OR (i.kind='event' AND i.visibility='public' AND i.published=1 AND i.post_url IS NOT NULL))
      ) OR (kind='task' AND NOT EXISTS (
        SELECT 1 FROM tasks t WHERE t.id=notifications.task_id AND t.revision=notifications.task_revision AND t.status='open'
      )))))`, [now, now]);
  // After an outage, send only the most recent elapsed interval for each recipient and entity.
  await db.run(`UPDATE notifications SET state='cancelled',locked_until=NULL
    WHERE kind NOT IN ('suggestion','reply') AND ((state='pending' AND next_attempt_at<=?) OR (state='sending' AND locked_until<=?)) AND scheduled_at<=? AND EXISTS (
      SELECT 1 FROM notifications newer WHERE newer.kind=notifications.kind
        AND newer.item_id=notifications.item_id AND IFNULL(newer.task_id,'')=IFNULL(notifications.task_id,'')
        AND newer.item_revision=notifications.item_revision AND IFNULL(newer.task_revision,0)=IFNULL(notifications.task_revision,0)
        AND newer.chat_id=notifications.chat_id AND IFNULL(newer.thread_id,0)=IFNULL(notifications.thread_id,0)
        AND newer.scheduled_at>notifications.scheduled_at AND newer.scheduled_at<=?
    )`, [now, now, now, now]);
  await db.run("UPDATE notifications SET state='failed',locked_until=NULL,last_error='Retry limit reached' WHERE state='sending' AND locked_until<=? AND attempts>=?", [now, MAX_ATTEMPTS]);
}

async function valid(db: Database, job: NotificationRow, now: number): Promise<boolean> {
  // One live query per delivery preserves role/privacy checks within D1 Free's 50-query invocation limit.
  const row = await db.get<{ allowed: number }>(`WITH config AS (
    SELECT CAST(MAX(CASE WHEN key='org_chat_id' THEN NULLIF(TRIM(value),'') END) AS INTEGER) AS org_chat,
      CAST(MAX(CASE WHEN key='org_thread_id' THEN NULLIF(TRIM(value),'') END) AS INTEGER) AS org_thread,
      CAST(MAX(CASE WHEN key='suggestions_chat_id' THEN NULLIF(TRIM(value),'') END) AS INTEGER) AS suggestions_chat,
      CAST(MAX(CASE WHEN key='suggestions_thread_id' THEN NULLIF(TRIM(value),'') END) AS INTEGER) AS suggestions_thread
    FROM settings
  ) SELECT 1 AS allowed FROM notifications n CROSS JOIN config c
    LEFT JOIN items i ON i.id=n.item_id LEFT JOIN tasks t ON t.id=n.task_id
    LEFT JOIN users u ON u.id=n.recipient_user_id LEFT JOIN groups g ON g.chat_id=n.chat_id
    WHERE n.id=? AND n.state='sending' AND (
      (n.kind='reply' AND (n.expires_at IS NULL OR n.expires_at>?)
        AND EXISTS (SELECT 1 FROM users actor WHERE actor.id=CAST(json_extract(n.payload,'$.actor_user_id') AS INTEGER)
          AND (json_extract(n.payload,'$.required_role') IS NULL OR (json_extract(n.payload,'$.required_role')='org' AND actor.role='org')))
        AND ((n.chat_id>0 AND EXISTS (SELECT 1 FROM users recipient WHERE recipient.id=n.chat_id AND recipient.dm_active=1))
          OR (n.chat_id<0 AND g.enabled=1
            AND (json_extract(n.payload,'$.required_role') IS NULL
              OR (g.org_only=1 AND (n.chat_id=c.org_chat OR n.chat_id=c.suggestions_chat))))))
      OR
      (n.kind='suggestion' AND n.chat_id<0 AND n.chat_id=c.suggestions_chat
        AND n.thread_id IS c.suggestions_thread AND (g.chat_id IS NULL OR g.enabled=1))
      OR (n.kind NOT IN ('suggestion','reply') AND i.revision=n.item_revision AND i.status NOT IN ('done','cancelled')
        AND n.expires_at>? AND (
          (n.kind='registration' AND i.kind='event' AND i.visibility='public' AND i.published=1
            AND i.post_url IS NOT NULL AND i.registration_deadline=n.expires_at AND (
              (n.recipient_user_id IS NOT NULL AND u.subscribed=1 AND u.dm_active=1 AND n.chat_id=u.id AND n.thread_id IS NULL)
              OR (n.recipient_user_id IS NULL AND n.chat_id<0 AND g.enabled=1 AND g.org_only=0 AND n.thread_id IS NULL
                AND n.chat_id IS NOT c.org_chat AND n.chat_id IS NOT c.suggestions_chat)))
          OR (n.kind IN ('event','post','task') AND (
              (n.kind IN ('event','post') AND i.kind=n.kind AND i.start_at=n.expires_at)
              OR (n.kind='task' AND t.item_id=i.id AND t.status='open' AND t.revision=n.task_revision AND COALESCE(t.due_at,i.start_at)=n.expires_at)
            ) AND (
              (n.recipient_user_id IS NOT NULL AND u.role='org' AND u.dm_active=1 AND n.chat_id=u.id AND n.thread_id IS NULL AND (
                (n.kind='task' AND EXISTS (SELECT 1 FROM task_assignees a WHERE a.task_id=t.id AND a.user_id=u.id))
                OR (n.kind!='task' AND EXISTS (SELECT 1 FROM item_assignees a WHERE a.item_id=i.id AND a.user_id=u.id))))
              OR (n.recipient_user_id IS NULL AND n.chat_id<0 AND n.chat_id=c.org_chat AND n.thread_id IS c.org_thread
                AND (g.chat_id IS NULL OR g.enabled=1) AND (
                  (n.kind='task' AND EXISTS (SELECT 1 FROM task_assignees a JOIN users assigned ON assigned.id=a.user_id WHERE a.task_id=t.id AND assigned.role='org'))
                  OR (n.kind!='task' AND EXISTS (SELECT 1 FROM item_assignees a JOIN users assigned ON assigned.id=a.user_id WHERE a.item_id=i.id AND assigned.role='org')))))
          )
        ))
    )`, [job.id, now, now]);
  return row !== null;
}

async function cancel(db: Database, id: string): Promise<void> {
  await db.run("UPDATE notifications SET state='cancelled',locked_until=NULL WHERE id=? AND state='sending'", [id]);
}

async function deliveryFailed(db: Database, job: NotificationRow, error: unknown, now: number): Promise<{ retryMs: number | null; queries: number }> {
  const apiError = error instanceof TelegramApiError ? error : null;
  const code = apiError?.errorCode ?? 0;
  const unavailable = code === 403 || (code === 400 && /chat not found|user is deactivated/i.test(apiError?.description ?? ''));
  if (unavailable) {
    if (job.recipient_user_id !== null) await db.run('UPDATE users SET dm_active=0,updated_at=? WHERE id=?', [now, job.recipient_user_id]);
    else if (job.chat_id < 0) await db.run(`INSERT INTO groups(chat_id,title,enabled,org_only,updated_at) VALUES (?, 'Недоступная группа',0,0,?)
      ON CONFLICT(chat_id) DO UPDATE SET enabled=0,updated_at=excluded.updated_at`, [job.chat_id, now]);
  }
  const transient = code === 0 || code === 429 || code >= 500;
  const retryMs = code === 429 ? Math.max(1, apiError?.retryAfter ?? 60) * 1000 : Math.min(60 * 60 * 1000, 30_000 * 2 ** Math.min(job.attempts - 1, 7));
  const canRetry = transient && job.attempts < MAX_ATTEMPTS && (job.expires_at === null || now + retryMs < job.expires_at);
  // Store controlled diagnostics, never arbitrary network exception strings (which can contain URLs/tokens).
  await db.run(`UPDATE notifications SET state=?,next_attempt_at=?,locked_until=NULL,last_error=? WHERE id=? AND state='sending'`,
    [canRetry ? 'pending' : 'failed', now + retryMs, code ? `Telegram API ${code}` : 'Temporary transport error', job.id]);
  if (code === 429) {
    await db.run("INSERT INTO settings(key,value) VALUES ('telegram_backoff_until',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [String(now + retryMs)]);
  }
  return { retryMs: code === 429 ? retryMs : null, queries: 1 + Number(unavailable) + Number(code === 429) };
}

async function deliver(env: Env, db: Database, telegram: TelegramApi, now: number,
  notificationIds?: string[], priorQueries = 0): Promise<{ queued: number; sent: number; failed: number }> {
  const startedAt = Date.now();
  const result = { queued: 0, sent: 0, failed: 0 };
  let queries = priorQueries;
  const ids = notificationIds === undefined ? undefined : [...new Set(notificationIds)].slice(0, 15);
  if (ids?.length === 0) return result;
  const backoff = await db.get<{ value: string }>("SELECT value FROM settings WHERE key='telegram_backoff_until'");
  queries++;
  if (Number(backoff?.value ?? 0) > now) {
    if (ids) await db.run(`UPDATE notifications SET locked_until=? WHERE state='pending' AND id IN (${ids.map(() => '?').join(',')})`, [Number(backoff!.value), ...ids]);
    return result;
  }
  const requested = Number(env.BROADCAST_BATCH_SIZE ?? '15');
  const size = ids?.length ?? (Number.isFinite(requested) ? Math.max(1, Math.min(15, Math.floor(requested))) : 15);
  const jobs = await db.all<NotificationRow>(`UPDATE notifications SET state='sending',attempts=attempts+1,locked_until=?
    WHERE id IN (SELECT id FROM notifications
      WHERE ((state='pending' AND next_attempt_at<=?) OR (state='sending' AND locked_until<=?))
        AND scheduled_at<=? AND (expires_at IS NULL OR expires_at>?) AND attempts<?
        ${ids ? `AND id IN (${ids.map(() => '?').join(',')})` : ''}
      ORDER BY CASE kind WHEN 'reply' THEN 0 WHEN 'suggestion' THEN 1 ELSE 2 END,
        CASE WHEN kind IN ('reply','suggestion') THEN scheduled_at END ASC, scheduled_at DESC LIMIT ?) RETURNING *`,
  [now + LEASE_MS, now, now, now, now, MAX_ATTEMPTS, ...(ids ?? []), size]);
  queries++;
  // SQLite RETURNING does not guarantee the subquery's order.
  jobs.sort(compareDelivery);

  async function release(remaining: NotificationRow[], retryAt: number): Promise<void> {
    if (!remaining.length) return;
    await db.run(`UPDATE notifications SET state='pending',attempts=MAX(0,attempts-1),next_attempt_at=MAX(next_attempt_at,?),locked_until=NULL
      WHERE state='sending' AND id IN (${remaining.map(() => '?').join(',')})`, [retryAt, ...remaining.map((job) => job.id)]);
    queries++;
  }

  for (let index = 0; index < jobs.length; index++) {
    const job = jobs[index];
    // Leave capacity for validation, a permanent failure with recipient cleanup, and releasing the remaining lease.
    if (queries > 45) {
      await release(jobs.slice(index), now);
      break;
    }
    const deliveryNow = now + Math.max(0, Date.now() - startedAt);
    const allowed = await valid(db, job, deliveryNow);
    queries++;
    if (!allowed) {
      await cancel(db, job.id);
      queries++;
      continue;
    }
    let payload: NotificationPayload;
    try {
      payload = JSON.parse(job.payload) as NotificationPayload;
      if (!payload.body || !['sendMessage', 'copyMessage'].includes(payload.method)) throw new Error('Invalid payload');
    } catch {
      await db.run("UPDATE notifications SET state='failed',locked_until=NULL,last_error='Invalid notification payload' WHERE id=?", [job.id]);
      queries++;
      result.failed++;
      continue;
    }
    const body: Record<string, unknown> = { ...payload.body, chat_id: job.chat_id };
    if (job.thread_id !== null) body.message_thread_id = job.thread_id;
    else delete body.message_thread_id;
    try {
      const message = await telegram.call<{ message_id: number }>(payload.method, body);
      await db.run("UPDATE notifications SET state='sent',sent_at=?,telegram_message_id=?,locked_until=NULL,last_error=NULL WHERE id=? AND state='sending'",
        [deliveryNow, message.message_id, job.id]);
      queries++;
      result.sent++;
    } catch (error) {
      result.failed++;
      const { retryMs, queries: failureQueries } = await deliveryFailed(db, job, error, deliveryNow);
      queries += failureQueries;
      if (retryMs !== null) {
        // Telegram rate limits can apply bot-wide. Release the rest without sending into the same limit.
        await release(jobs.slice(index + 1), deliveryNow + retryMs);
        break;
      }
    }
  }
  return result;
}

/** Queue consumers lease only their own IDs; duplicate messages cannot send an already-completed job. */
export async function dispatchNotifications(env: Env, db: Database, telegram: TelegramApi, now = Date.now(),
  notificationIds?: string[]): Promise<{ queued: number; sent: number; failed: number }> {
  return deliver(env, db, telegram, now, notificationIds);
}

export async function runReminders(env: Env, db: Database, telegram: TelegramApi, now = Date.now()): Promise<{ queued: number; sent: number; failed: number }> {
  const enqueued = await enqueue(env, db, now);
  await cancelObsolete(db, now);
  if (!env.DELIVERY_QUEUE) {
    const sent = await deliver(env, db, telegram, now, undefined, enqueued.queries + 3);
    return { ...sent, queued: enqueued.queued };
  }
  const result = { queued: enqueued.queued, sent: 0, failed: 0 };
  const backoff = await db.get<{ value: string }>("SELECT value FROM settings WHERE key='telegram_backoff_until'");
  if (Number(backoff?.value ?? 0) > now) return result;
  // Reserve pending rows so an ordinary slow queue does not publish duplicates every cron tick.
  // If publication/processing is interrupted, cron recovers the reservation after five minutes.
  const jobs = await db.all<DeliveryOrder>(`UPDATE notifications SET state='pending',locked_until=?
    WHERE id IN (SELECT id FROM notifications WHERE
      ((state='pending' AND (locked_until IS NULL OR locked_until<=?)) OR (state='sending' AND locked_until<=?))
      AND scheduled_at<=? AND next_attempt_at<=? AND attempts<? AND (expires_at IS NULL OR expires_at>?)
      ORDER BY CASE kind WHEN 'reply' THEN 0 WHEN 'suggestion' THEN 1 ELSE 2 END,
        CASE WHEN kind IN ('reply','suggestion') THEN scheduled_at END ASC, scheduled_at DESC LIMIT 1000)
    RETURNING id,kind,scheduled_at,created_at`, [now + LEASE_MS, now, now, now, now, MAX_ATTEMPTS, now]);
  jobs.sort(compareDelivery);
  for (let index = 0; index < jobs.length; index += 100) {
    const chunk = jobs.slice(index, index + 100);
    try {
      await env.DELIVERY_QUEUE.sendBatch(chunk.map((job) => ({ body: { notificationId: job.id } })));
    } catch (error) {
      await db.run(`UPDATE notifications SET locked_until=NULL WHERE state='pending' AND id IN (${chunk.map(() => '?').join(',')})`, chunk.map((job) => job.id));
      throw error;
    }
  }
  return result;
}
