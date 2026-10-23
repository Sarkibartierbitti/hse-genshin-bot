import { handleUpdate } from './bot.js';
import { Database } from './db.js';
import { dispatchNotifications, runReminders } from './reminders.js';
import { BufferedTelegramApi, commitReplies } from './replies.js';
import { claimTelegramUpdate } from './store.js';
import { TelegramApi } from './telegram.js';
import type { Env, TelegramUpdate } from './types.js';

const response = (text: string, status = 200): Response => new Response(text, {
  status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
});

function validSecret(actual: string | null, expected: string): boolean {
  if (!actual || !expected || actual.length !== expected.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) mismatch |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return mismatch === 0;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === '/health' && request.method === 'GET') return response('ok');
    if (path !== '/webhook') return response('Not found', 404);
    if (request.method !== 'POST') return response('Method not allowed', 405);
    if (!env.TELEGRAM_BOT_TOKEN || !env.WEBHOOK_SECRET) return response('Not configured', 503);
    if (!validSecret(request.headers.get('X-Telegram-Bot-Api-Secret-Token'), env.WEBHOOK_SECRET)) return response('Forbidden', 403);
    if (Number(request.headers.get('Content-Length')) > 1_048_576) return response('Payload too large', 413);

    let update: TelegramUpdate;
    try {
      const body = await request.text();
      if (body.length > 1_048_576) return response('Payload too large', 413);
      const parsed: unknown = JSON.parse(body);
      if (!parsed || typeof parsed !== 'object' || !Number.isSafeInteger((parsed as TelegramUpdate).update_id)) return response('Invalid update', 400);
      update = parsed as TelegramUpdate;
    } catch {
      return response('Invalid JSON', 400);
    }

    const db = new Database(env.DB);
    const now = Date.now();
    let claimed = false;
    let completed = false;
    let leaseUntil = 0;
    try {
      const state = await claimTelegramUpdate(db, update.update_id, now);
      if (state === 'done') return response('ok');
      if (state === 'busy') return response('Retry later', 503);
      claimed = true;
      const lease = await db.get<{ lease_until: number }>('SELECT lease_until FROM telegram_updates WHERE update_id=?', [update.update_id]);
      leaseUntil = lease?.lease_until ?? 0;
      const buffered = new BufferedTelegramApi(env.TELEGRAM_BOT_TOKEN);
      await handleUpdate(update, env, db, buffered, now);
      const actorId = update.callback_query?.from.id ?? update.message?.from?.id ?? update.my_chat_member?.from.id ?? null;
      const ids = await commitReplies(db, update.update_id, leaseUntil, actorId, buffered.messages, Date.now());
      completed = true;
      if (ids.length) await dispatchNotifications(env, db, new TelegramApi(env.TELEGRAM_BOT_TOKEN), Date.now() + ids.length, ids);
      return response('ok');
    } catch {
      // A failed reply cannot replay already-committed form input. The cron will retry its outbox job.
      if (completed) return response('ok');
      if (claimed) await db.run("UPDATE telegram_updates SET lease_until=0 WHERE update_id=? AND state='processing' AND lease_until=?", [update.update_id, leaseUntil]).catch(() => undefined);
      console.error(JSON.stringify({ event: 'webhook_failed', update_id: update.update_id }));
      return response('Temporary error', 503);
    }
  },

  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    const ids = batch.messages.map(message => {
      if (!message.body || typeof message.body !== 'object') return null;
      const id = (message.body as { notificationId?: unknown }).notificationId;
      return typeof id === 'string' ? id : null;
    }).filter((id): id is string => id !== null);
    if (!ids.length) { batch.ackAll(); return; }
    try {
      await dispatchNotifications(env, new Database(env.DB), new TelegramApi(env.TELEGRAM_BOT_TOKEN), Date.now(), ids);
      // Failed sends remain in the D1 outbox with next_attempt_at; cron republishes them when due.
      batch.ackAll();
    } catch {
      batch.retryAll({ delaySeconds: 60 });
      console.error(JSON.stringify({ event: 'delivery_batch_failed', count: ids.length }));
    }
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (!env.TELEGRAM_BOT_TOKEN) return;
    const job = runReminders(env, new Database(env.DB), new TelegramApi(env.TELEGRAM_BOT_TOKEN));
    ctx.waitUntil(job.then(result => {
      console.log(JSON.stringify({ event: 'reminders_run', ...result }));
    }).catch(() => {
      console.error(JSON.stringify({ event: 'reminders_failed' }));
      throw new Error('Reminder job failed');
    }));
  },
} satisfies ExportedHandler<Env>;
