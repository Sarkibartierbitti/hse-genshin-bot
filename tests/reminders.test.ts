import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDatabase } from './helpers/database.js';
import { dispatchNotifications, runReminders } from '../src/reminders.js';
import { TelegramApi, TelegramApiError } from '../src/telegram.js';
import { HOUR } from '../src/time.js';
import type { Database } from '../src/db.js';
import type { Env, NotificationRow } from '../src/types.js';

const NOW = Date.UTC(2026, 9, 23, 9);
const CREATED = NOW - 30 * 24 * HOUR;
type Call = { method: string; body: Record<string, unknown> };

function fakeApi(onCall?: (call: Call) => void | Promise<void>) {
  const calls: Call[] = [];
  const api = new TelegramApi('test', (async (_url: string | URL | Request, init?: RequestInit) => {
    const method = String(_url).split('/').at(-1)!;
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const call = { method, body };
    calls.push(call);
    await onCall?.(call);
    return new Response(JSON.stringify({ ok: true, result: { message_id: calls.length } }));
  }) as typeof fetch);
  return { api, calls };
}

function env(binding: D1Database, extra: Partial<Env> = {}): Env {
  return { DB: binding, TELEGRAM_BOT_TOKEN: 'test', WEBHOOK_SECRET: 'test', ...extra };
}

async function seed(db: Database, options: { visibility?: string; published?: number; start?: number; registration?: number | null } = {}) {
  for (const [id, role, subscribed] of [[1, 'org', 0], [2, 'org', 0], [3, 'member', 1], [4, 'member', 0]] as const) {
    await db.run('INSERT INTO users(id,username,display_name,role,subscribed,dm_active,created_at,updated_at) VALUES (?,?,?,?,?,1,?,?)',
      [id, `user${id}`, `User ${id}`, role, subscribed, CREATED, CREATED]);
  }
  await db.run(`INSERT INTO items(id,kind,title,start_at,visibility,status,location,post_url,registration_deadline,published,created_by,revision,created_at,updated_at)
    VALUES ('event','event','Genshin festival',?,?,'ready','HSE','https://t.me/hsegenshin/42',?,?,1,1,?,?)`,
    [options.start ?? NOW + 168 * HOUR, options.visibility ?? 'public', options.registration === undefined ? NOW + 72 * HOUR : options.registration,
      options.published ?? 1, CREATED, CREATED]);
  await db.run("INSERT INTO item_assignees(item_id,user_id) VALUES ('event',1)");
  for (const [chatId, orgOnly] of [[-10, 1], [-20, 0], [-30, 1]] as const) {
    await db.run('INSERT INTO groups(chat_id,title,enabled,org_only,updated_at) VALUES (?, ?,1,?,?)', [chatId, `Group ${chatId}`, orgOnly, CREATED]);
  }
  for (const [key, value] of [['org_chat_id', '-10'], ['org_thread_id', '11'], ['suggestions_chat_id', '-30'], ['suggestions_thread_id', '22']]) {
    await db.run('INSERT INTO settings(key,value) VALUES (?,?)', [key, value]);
  }
}

async function addTask(db: Database, id: string, due: number | null = null) {
  await db.run("INSERT INTO tasks(id,item_id,title,due_at,status,created_by,revision,created_at,updated_at) VALUES (?,'event',?,?, 'open',1,1,?,?)", [id, `Task ${id}`, due, CREATED, CREATED]);
  await db.run('INSERT INTO task_assignees(task_id,user_id) VALUES (?,2)', [id]);
}

test('queues future 168/72/24 jobs and sends public and internal routes without duplicates', async (t) => {
  const { db, binding, close } = createTestDatabase(); t.after(close);
  await seed(db);
  await addTask(db, 'fallback');
  const { api, calls } = fakeApi();
  const result = await runReminders(env(binding), db, api, NOW);
  assert.equal(result.queued, 16); // event 6, task 6, registration 4
  assert.equal(result.sent, 6);
  assert.deepEqual(calls.filter((call) => String(call.body.text).includes('о регистрации')).map((call) => call.body.chat_id).sort(), [-20, 3]);
  assert.equal(calls.filter((call) => call.body.chat_id === -10).length, 2);
  assert.ok(calls.filter((call) => call.body.chat_id === -10).every((call) => call.body.message_thread_id === 11));
  assert.equal(calls.some((call) => call.body.chat_id === -30 || call.body.chat_id === 4), false);
  const again = await runReminders(env(binding), db, api, NOW);
  assert.deepEqual(again, { queued: 0, sent: 0, failed: 0 });
});

test('private and unpublished events never create registration broadcasts', async (t) => {
  for (const options of [{ visibility: 'private' }, { published: 0 }]) {
    const { db, binding, close } = createTestDatabase(); t.after(close);
    await seed(db, options);
    const { api, calls } = fakeApi();
    await runReminders(env(binding), db, api, NOW);
    assert.equal(calls.some((call) => call.body.chat_id === -20 || call.body.chat_id === 3), false);
    assert.equal((await db.all("SELECT id FROM notifications WHERE kind='registration'")).length, 0);
  }
});

test('new cards skip elapsed intervals and fallback tasks use the event date', async (t) => {
  const { db, binding, close } = createTestDatabase(); t.after(close);
  await seed(db, { start: NOW + 48 * HOUR, registration: null });
  await db.run('UPDATE items SET created_at=?,updated_at=?', [NOW, NOW]);
  await addTask(db, 'fallback');
  await db.run('UPDATE tasks SET created_at=?,updated_at=?', [NOW, NOW]);
  const { api } = fakeApi();
  const result = await runReminders(env(binding), db, api, NOW);
  assert.deepEqual(result, { queued: 4, sent: 0, failed: 0 });
  const jobs = await db.all<NotificationRow>('SELECT * FROM notifications');
  assert.ok(jobs.every((job) => job.scheduled_at === NOW + 24 * HOUR));
});

test('date edits cancel old revisions and reschedule both tasks and event', async (t) => {
  const { db, binding, close } = createTestDatabase(); t.after(close);
  await seed(db, { start: NOW + 200 * HOUR, registration: null });
  await addTask(db, 'fallback');
  const { api } = fakeApi();
  await runReminders(env(binding), db, api, NOW);
  await db.run('UPDATE items SET start_at=?,revision=revision+1,updated_at=?', [NOW + 240 * HOUR, NOW]);
  await runReminders(env(binding), db, api, NOW);
  const old = await db.all<NotificationRow>('SELECT * FROM notifications WHERE item_revision=1');
  assert.equal(old.length, 12);
  assert.ok(old.every((job) => job.state === 'cancelled'));
  const current = await db.all<NotificationRow>('SELECT * FROM notifications WHERE item_revision=2');
  assert.equal(current.length, 12);
  assert.ok(current.every((job) => job.expires_at === NOW + 240 * HOUR));
});

test('delivery rechecks subscription, roles, groups and task completion after queueing', async (t) => {
  const { db, binding, close } = createTestDatabase(); t.after(close);
  await seed(db, { start: NOW + 169 * HOUR, registration: NOW + 73 * HOUR });
  await addTask(db, 'closed');
  const { api, calls } = fakeApi();
  await runReminders(env(binding), db, api, NOW);
  await db.run('UPDATE users SET subscribed=0 WHERE id=3');
  await db.run("UPDATE users SET role='member' WHERE id=1");
  await db.run('UPDATE groups SET enabled=0 WHERE chat_id=-20');
  await db.run("UPDATE tasks SET status='done',revision=revision+1 WHERE id='closed'");
  const result = await runReminders(env(binding), db, api, NOW + HOUR);
  assert.equal(result.sent, 0);
  assert.equal(calls.length, 0);
});

test('recovery collapses missed intervals and never sends after the anchor', async (t) => {
  const { db, binding, close } = createTestDatabase(); t.after(close);
  await seed(db, { start: NOW + 200 * HOUR, registration: null });
  const { api, calls } = fakeApi();
  await runReminders(env(binding), db, api, NOW);
  await runReminders(env(binding), db, api, NOW + 180 * HOUR);
  assert.equal(calls.length, 2); // latest 24h interval only, DM and org topic
  const cancelled = await db.all<NotificationRow>("SELECT * FROM notifications WHERE state='cancelled'");
  assert.equal(cancelled.length, 4);
  await runReminders(env(binding), db, api, NOW + 201 * HOUR);
  assert.equal(calls.length, 2);
});

test('429 honours retry_after across runs and releases unsent batch leases', async (t) => {
  const { db, binding, close } = createTestDatabase(); t.after(close);
  await seed(db);
  let blocked = true;
  const calls: Call[] = [];
  const api = { async call(_method: string, body: Record<string, unknown>) {
    calls.push({ method: _method, body });
    if (blocked) throw new TelegramApiError(429, 'Too many requests', 120);
    return { message_id: calls.length };
  } } as unknown as TelegramApi;
  assert.equal((await runReminders(env(binding), db, api, NOW)).failed, 1);
  assert.equal(calls.length, 1);
  await runReminders(env(binding), db, api, NOW + 60_000);
  assert.equal(calls.length, 1);
  blocked = false;
  assert.equal((await runReminders(env(binding), db, api, NOW + 121_000)).sent, 4);
  assert.equal((await db.all<NotificationRow>("SELECT * FROM notifications WHERE state='sending'")).length, 0);
});

test('403 stops DM sends and disables groups', async (t) => {
  const { db, binding, close } = createTestDatabase(); t.after(close);
  await seed(db);
  const api = { async call() { throw new TelegramApiError(403, 'Forbidden'); } } as unknown as TelegramApi;
  await runReminders(env(binding), db, api, NOW);
  assert.equal((await db.get<{ dm_active: number }>('SELECT dm_active FROM users WHERE id=1'))?.dm_active, 0);
  assert.equal((await db.get<{ dm_active: number }>('SELECT dm_active FROM users WHERE id=3'))?.dm_active, 0);
  assert.equal((await db.get<{ enabled: number }>('SELECT enabled FROM groups WHERE chat_id=-20'))?.enabled, 0);
  const failed = await db.all<NotificationRow>("SELECT * FROM notifications WHERE state='failed'");
  assert.equal(failed.length, 4);
});

test('transient errors retry with backoff and the eighth attempt is terminal', async (t) => {
  const { db, binding, close } = createTestDatabase(); t.after(close);
  await seed(db, { registration: null });
  let failing = true;
  const api = { async call() {
    if (failing) throw new TelegramApiError(503, 'Unavailable');
    return { message_id: 1 };
  } } as unknown as TelegramApi;
  await runReminders(env(binding), db, api, NOW);
  const retrying = await db.all<NotificationRow>("SELECT * FROM notifications WHERE attempts=1");
  assert.equal(retrying.length, 2);
  assert.ok(retrying.every((job) => job.state === 'pending' && job.next_attempt_at >= NOW + 30_000));
  assert.equal((await runReminders(env(binding), db, api, NOW + 10_000)).failed, 0);
  await db.run("UPDATE notifications SET attempts=7,next_attempt_at=? WHERE attempts=1", [NOW]);
  const lastAttempt = await runReminders(env(binding), db, api, NOW + 31_000);
  assert.equal(lastAttempt.failed, 2);
  const failed = await db.all<NotificationRow>("SELECT * FROM notifications WHERE attempts=8");
  assert.ok(failed.every((job) => job.state === 'failed'));
  failing = false;
  assert.equal((await runReminders(env(binding), db, api, NOW + HOUR)).sent, 0);
});

test('a post and subtask with its own deadline keep independent reminder anchors', async (t) => {
  const { db, binding, close } = createTestDatabase(); t.after(close);
  await seed(db, { start: NOW + 200 * HOUR, registration: null });
  await db.run("UPDATE items SET kind='post',visibility='private',published=0");
  await addTask(db, 'parent');
  await addTask(db, 'child', NOW + 72 * HOUR);
  await db.run("UPDATE tasks SET parent_id='parent' WHERE id='child'");
  const { api, calls } = fakeApi();
  await runReminders(env(binding), db, api, NOW);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => String(call.body.text).includes('Task child')));
  const postJobs = await db.all<NotificationRow>("SELECT * FROM notifications WHERE kind='post'");
  assert.equal(postJobs.length, 6);
  assert.ok(postJobs.every((job) => job.expires_at === NOW + 200 * HOUR));
  const childJobs = await db.all<NotificationRow>("SELECT * FROM notifications WHERE task_id='child'");
  assert.ok(childJobs.every((job) => job.expires_at === NOW + 72 * HOUR));
});

test('large queues backfill across ticks and stay below 50 D1 statements per invocation', async (t) => {
  const { db, binding, close } = createTestDatabase(); t.after(close);
  await seed(db);
  for (let id = 10; id < 40; id++) {
    await db.run("INSERT INTO users(id,display_name,role,subscribed,dm_active,created_at,updated_at) VALUES (?,?,'member',1,1,?,?)", [id, `User ${id}`, CREATED, CREATED]);
  }
  const originalPrepare = binding.prepare.bind(binding);
  let count = 0;
  binding.prepare = ((sql: string) => { count++; return originalPrepare(sql); }) as D1Database['prepare'];
  const { api, calls } = fakeApi();
  let queued = 0;
  for (let tick = 0; tick < 3; tick++) {
    count = 0;
    const result = await runReminders(env(binding), db, api, NOW + tick * 60_000);
    queued += result.queued;
    assert.ok(count <= 50, `used ${count} D1 statements`);
  }
  assert.equal(queued, 70); // 6 internal event jobs + 32 public destinations * 2 intervals
  assert.equal(calls.length, 34); // 2 internal and 32 due public notifications, once each
});

test('concurrent schedulers atomically lease jobs and recover abandoned leases', async (t) => {
  const { db, binding, close } = createTestDatabase(); t.after(close);
  await seed(db);
  const { api, calls } = fakeApi();
  await Promise.all([runReminders(env(binding), db, api, NOW), runReminders(env(binding), db, api, NOW)]);
  assert.equal(calls.length, 4);
  await db.run("UPDATE notifications SET state='sending',locked_until=?,attempts=1 WHERE kind='event' AND scheduled_at=?", [NOW - 1, NOW]);
  const result = await runReminders(env(binding), db, api, NOW);
  assert.equal(result.sent, 2);
});

test('suggestion copyMessage notifications use configured dedicated topic', async (t) => {
  const { db, binding, close } = createTestDatabase(); t.after(close);
  await seed(db, { start: NOW + 200 * HOUR, registration: null });
  await db.run(`INSERT INTO notifications(id,dedupe_key,kind,chat_id,thread_id,scheduled_at,payload,state,next_attempt_at,created_at)
    VALUES ('idea','idea','suggestion',-30,22,?,?,'pending',?,?)`,
    [NOW, JSON.stringify({ method: 'copyMessage', body: { chat_id: -999, message_thread_id: 99, from_chat_id: 3, message_id: 42 } }), NOW, NOW]);
  const { api, calls } = fakeApi();
  await runReminders(env(binding), db, api, NOW);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { method: 'copyMessage', body: { chat_id: -30, message_thread_id: 22, from_chat_id: 3, message_id: 42 } });
});

test('reply jobs retry in original order and recheck the actor role and expiration', async (t) => {
  const { db, binding, close } = createTestDatabase(); t.after(close);
  await seed(db, { start: NOW + 200 * HOUR, registration: null });
  async function reply(id: string, actor: number, chatId: number, at: number, expires = NOW + 600_000) {
    await db.run(`INSERT INTO notifications(id,dedupe_key,kind,recipient_user_id,chat_id,scheduled_at,expires_at,payload,state,next_attempt_at,created_at)
      VALUES (?,?,'reply',?,?,?,?,?,'pending',?,?)`, [id, id, chatId > 0 ? chatId : null, chatId, at, expires,
      JSON.stringify({ method: 'sendMessage', body: { text: id }, actor_user_id: actor, required_role: 'org' }), at, CREATED]);
  }
  await reply('second', 1, 1, NOW - 1000);
  await reply('first', 1, 1, NOW - 2000);
  await reply('demoted', 2, 2, NOW - 3000);
  await reply('expired', 1, 1, NOW - 4000, NOW - 1);
  await db.run("UPDATE users SET role='member' WHERE id=2");
  const { api, calls } = fakeApi();
  const result = await runReminders(env(binding), db, api, NOW);
  assert.equal(result.sent, 2);
  assert.deepEqual(calls.map((call) => call.body.text), ['first', 'second']);
  assert.equal((await db.get<NotificationRow>("SELECT * FROM notifications WHERE id='demoted'"))?.state, 'cancelled');
  assert.equal((await db.get<NotificationRow>("SELECT * FROM notifications WHERE id='expired'"))?.state, 'cancelled');
});

test('native queue fans out 500 due broadcasts and duplicate consumer IDs cannot send twice', async (t) => {
  const { db, binding, close } = createTestDatabase(); t.after(close);
  await seed(db);
  const anchor = NOW + 72 * HOUR;
  for (let id = 1000; id < 1500; id++) {
    await db.run("INSERT INTO users(id,display_name,role,subscribed,dm_active,created_at,updated_at) VALUES (?,?,'member',1,1,?,?)", [id, `User ${id}`, CREATED, CREATED]);
    await db.run(`INSERT INTO notifications(id,dedupe_key,kind,item_id,item_revision,recipient_user_id,chat_id,scheduled_at,expires_at,payload,state,next_attempt_at,created_at)
      VALUES (?,?,'registration','event',1,?,?,?,?,?,'pending',?,?)`,
      [`broadcast${id}`, `registration:event:1:-:-:user:${id}:0:${anchor}:72`, id, id, NOW, anchor,
        JSON.stringify({ method: 'sendMessage', body: { text: 'Registration reminder' } }), NOW, CREATED]);
  }
  const published: string[] = [];
  const queue = { async sendBatch(messages: { body: { notificationId: string } }[]) {
    assert.ok(messages.length <= 100);
    published.push(...messages.map((message) => message.body.notificationId));
  } } as unknown as Queue<{ notificationId: string }>;
  const config = env(binding, { DELIVERY_QUEUE: queue });
  const { api, calls } = fakeApi();
  const producer = await runReminders(config, db, api, NOW);
  assert.equal(producer.sent, 0);
  assert.equal(calls.length, 0);
  assert.ok(published.length >= 500);
  const publishedCount = published.length;
  await runReminders(config, db, api, NOW + 60_000);
  assert.equal(published.length, publishedCount, 'queue reservations avoid republishing every minute');
  for (let index = 0; index < published.length; index += 10) {
    const ids = published.slice(index, index + 10);
    const first = await dispatchNotifications(config, db, api, NOW + 60_000, ids);
    assert.equal(first.sent, ids.length);
    const duplicate = await dispatchNotifications(config, db, api, NOW + 60_000, ids);
    assert.equal(duplicate.sent, 0);
  }
  assert.equal(calls.length, publishedCount);
});

test('native queue recovers abandoned delivery leases after a consumer crash', async (t) => {
  const { db, binding, close } = createTestDatabase(); t.after(close);
  await seed(db, { registration: null });
  const ids: string[] = [];
  const queue = { async sendBatch(messages: { body: { notificationId: string } }[]) { ids.push(...messages.map((message) => message.body.notificationId)); } } as unknown as Queue<{ notificationId: string }>;
  const config = env(binding, { DELIVERY_QUEUE: queue });
  const { api } = fakeApi();
  await runReminders(config, db, api, NOW);
  assert.equal(ids.length, 2);
  await db.run("UPDATE notifications SET state='sending',attempts=1,locked_until=? WHERE scheduled_at=?", [NOW - 1, NOW]);
  ids.length = 0;
  await runReminders(config, db, api, NOW + 1000);
  assert.equal(ids.length, 2);
  assert.equal((await dispatchNotifications(config, db, api, NOW + 1000, ids)).sent, 2);
});
