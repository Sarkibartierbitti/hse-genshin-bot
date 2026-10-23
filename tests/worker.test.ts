import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { claimTelegramUpdate } from '../src/store.js';
import { BufferedTelegramApi, commitReplies } from '../src/replies.js';
import { dispatchNotifications } from '../src/reminders.js';
import { TelegramApi } from '../src/telegram.js';
import type { Env, NotificationRow, SessionRow, TelegramUpdate } from '../src/types.js';
import { createTestDatabase } from './helpers/database.js';

const update = (id: number, text: string): TelegramUpdate => ({ update_id: id,
  message: { message_id: id, from: { id: 101, first_name: 'Орг', username: 'organizer' },
    chat: { id: 101, type: 'private' }, text } });
const request = (value: unknown, secret = 'test-secret'): Request => new Request('https://bot.example/webhook', {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret }, body: JSON.stringify(value),
});
const environment = (DB: D1Database): Env => ({ DB, TELEGRAM_BOT_TOKEN: 'fake-token', WEBHOOK_SECRET: 'test-secret', BOOTSTRAP_ORG_IDS: '101' });

test('health, routes, secret and JSON are validated before processing', async () => {
  const env = environment({ prepare() { throw new Error('Must not touch DB'); } } as unknown as D1Database);
  assert.equal((await worker.fetch(new Request('https://bot.example/health'), env)).status, 200);
  assert.equal((await worker.fetch(new Request('https://bot.example/elsewhere'), env)).status, 404);
  assert.equal((await worker.fetch(new Request('https://bot.example/webhook'), env)).status, 405);
  assert.equal((await worker.fetch(request(update(1, '/start'), 'wrong'), env)).status, 403);
  assert.equal((await worker.fetch(request({ update_id: 'invalid' }), env)).status, 400);
  assert.equal((await worker.fetch(request(null), env)).status, 400);
});

test('a duplicate completed webhook sends one menu; an active lease returns retryable status', async () => {
  const { db, binding, close } = createTestDatabase();
  const env = environment(binding);
  const previousFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return Response.json({ ok: true, result: { message_id: calls } }); }) as typeof fetch;
  try {
    assert.equal((await worker.fetch(request(update(10, '/start')), env)).status, 200);
    assert.equal((await worker.fetch(request(update(10, '/start')), env)).status, 200);
    assert.equal(calls, 1);
    assert.equal((await db.get<{ state: string }>('SELECT state FROM telegram_updates WHERE update_id=10'))?.state, 'done');
    await claimTelegramUpdate(db, 11, Date.now());
    assert.equal((await worker.fetch(request(update(11, '/start')), env)).status, 503);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = previousFetch; close(); }
});

test('a Telegram failure after form advancement retries the reply without reapplying the input', async () => {
  const { db, binding, close } = createTestDatabase();
  const env = environment(binding);
  const previousFetch = globalThis.fetch;
  let fail = false;
  globalThis.fetch = (async () => fail
    ? Response.json({ ok: false, error_code: 503, description: 'Unavailable' }, { status: 503 })
    : Response.json({ ok: true, result: { message_id: 9 } })) as typeof fetch;
  try {
    await worker.fetch(request(update(20, '➕ Мероприятие')), env);
    fail = true;
    assert.equal((await worker.fetch(request(update(21, 'Встреча клуба')), env)).status, 200);
    const session = await db.get<SessionRow>('SELECT * FROM sessions WHERE user_id=101');
    assert.equal(session?.step, 'status');
    assert.equal(JSON.parse(session!.data).values.title, 'Встреча клуба');
    assert.equal((await worker.fetch(request(update(21, 'Встреча клуба')), env)).status, 200);
    assert.equal((await db.get<SessionRow>('SELECT * FROM sessions WHERE user_id=101'))?.step, 'status');
    const job = await db.get<NotificationRow>("SELECT * FROM notifications WHERE dedupe_key='reply:21:0'");
    assert.equal(job?.state, 'pending');
    fail = false;
    const retried = await dispatchNotifications(env, db, new TelegramApi(env.TELEGRAM_BOT_TOKEN), Date.now() + 31_000, [job!.id]);
    assert.equal(retried.sent, 1);
    assert.equal((await db.get<NotificationRow>('SELECT * FROM notifications WHERE id=?', [job!.id]))?.state, 'sent');
  } finally { globalThis.fetch = previousFetch; close(); }
});

test('a stale lease cannot mark a newer owner done or enqueue its output', async () => {
  const { db, close } = createTestDatabase();
  try {
    await claimTelegramUpdate(db, 30, 1_000);
    await assert.rejects(commitReplies(db, 30, 60_999, null, [{ method: 'sendMessage', body: { chat_id: -100, text: 'stale' } }], 2_000));
    assert.equal((await db.get<{ count: number }>('SELECT COUNT(*) AS count FROM notifications'))?.count, 0);
    assert.equal((await db.get<{ state: string }>('SELECT state FROM telegram_updates WHERE update_id=30'))?.state, 'processing');
  } finally { close(); }
});

test('delayed organizer UI output is cancelled if its recipient loses the role', async () => {
  const { db, binding, close } = createTestDatabase();
  const env = environment(binding);
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({ ok: false, error_code: 503 }, { status: 503 })) as typeof fetch;
  try {
    await worker.fetch(request(update(40, '/start')), env);
    const job = await db.get<NotificationRow>("SELECT * FROM notifications WHERE dedupe_key='reply:40:0'");
    assert.equal(JSON.parse(job!.payload).required_role, 'org');
    await db.run("UPDATE users SET role='member' WHERE id=101");
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return Response.json({ ok: true, result: { message_id: 1 } }); }) as typeof fetch;
    await dispatchNotifications(env, db, new TelegramApi(env.TELEGRAM_BOT_TOKEN), Date.now() + 31_000, [job!.id]);
    assert.equal(calls, 0);
    assert.equal((await db.get<NotificationRow>('SELECT * FROM notifications WHERE id=?', [job!.id]))?.state, 'cancelled');
  } finally { globalThis.fetch = previousFetch; close(); }
});

test('organizer sensitivity captured while rendering survives revocation before outbox commit', async () => {
  const { db, binding, close } = createTestDatabase();
  try {
    const now = Date.now();
    await db.run("INSERT INTO users(id,display_name,role,dm_active,created_at,updated_at) VALUES(101,'Орг','org',1,?,?)", [now, now]);
    await claimTelegramUpdate(db, 50, now);
    const lease = await db.get<{ lease_until: number }>('SELECT lease_until FROM telegram_updates WHERE update_id=50');
    const buffer = new BufferedTelegramApi('fake');
    buffer.markOrganizerContent();
    await buffer.sendMessage(101, 'Внутренняя карточка');
    await db.run("UPDATE users SET role='member' WHERE id=101");
    const ids = await commitReplies(db, 50, lease!.lease_until, 101, buffer.messages, now);
    const api = new TelegramApi('fake');
    let calls = 0;
    api.call = async <T>() => { calls++; return { message_id: 1 } as T; };
    await dispatchNotifications(environment(binding), db, api, now + 100, ids);
    assert.equal(calls, 0);
    assert.equal((await db.get<NotificationRow>('SELECT * FROM notifications WHERE id=?', [ids[0]]))?.state, 'cancelled');
  } finally { close(); }
});

test('an organizer can receive a public menu in a public group without exposing internal controls', async () => {
  const { db, binding, close } = createTestDatabase();
  const env = environment(binding);
  const previousFetch = globalThis.fetch;
  let sent: Record<string, unknown> | null = null;
  globalThis.fetch = (async (_url, init) => { sent = JSON.parse(String(init?.body)); return Response.json({ ok: true, result: { message_id: 1 } }); }) as typeof fetch;
  try {
    await db.run("INSERT INTO groups(chat_id,title,enabled,org_only,updated_at) VALUES(-100,'Публичная',1,0,?)", [Date.now()]);
    const value = update(60, '/start');
    value.message!.chat = { id: -100, type: 'supergroup' };
    value.message!.message_thread_id = 7;
    assert.equal((await worker.fetch(request(value), env)).status, 200);
    assert.ok(sent);
    assert.equal((sent as Record<string, unknown>).message_thread_id, 7);
    assert.equal(JSON.stringify(sent).includes('Для оргов'), false);
    assert.equal((await db.get<NotificationRow>("SELECT * FROM notifications WHERE dedupe_key='reply:60:0'"))?.state, 'sent');
  } finally { globalThis.fetch = previousFetch; close(); }
});

test('queued internal group replies are cancelled if the organizer chat changes', async () => {
  const { db, binding, close } = createTestDatabase();
  try {
    const now = Date.now();
    await db.run("INSERT INTO users(id,display_name,role,created_at,updated_at) VALUES(101,'Орг','org',?,?)", [now, now]);
    await db.run("INSERT INTO groups(chat_id,title,enabled,org_only,updated_at) VALUES(-100,'Бывшая беседа',1,1,?)", [now]);
    await db.run("INSERT INTO settings(key,value) VALUES('org_chat_id','-100')");
    await claimTelegramUpdate(db, 61, now);
    const lease = await db.get<{ lease_until: number }>('SELECT lease_until FROM telegram_updates WHERE update_id=61');
    const buffer = new BufferedTelegramApi('fake');
    buffer.markOrganizerContent();
    await buffer.sendMessage(-100, 'Внутренняя карточка', { message_thread_id: 5 });
    const ids = await commitReplies(db, 61, lease!.lease_until, 101, buffer.messages, now);
    await db.run("UPDATE settings SET value='-200' WHERE key='org_chat_id'");
    const api = new TelegramApi('fake');
    let calls = 0;
    api.call = async <T>() => { calls++; return { message_id: 1 } as T; };
    await dispatchNotifications(environment(binding), db, api, now + 100, ids);
    assert.equal(calls, 0);
    assert.equal((await db.get<NotificationRow>('SELECT * FROM notifications WHERE id=?', [ids[0]]))?.state, 'cancelled');
  } finally { close(); }
});
