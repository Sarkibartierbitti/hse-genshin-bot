import test from 'node:test';
import assert from 'node:assert/strict';
import { handleUpdate } from '../src/bot.js';
import { TelegramApi } from '../src/telegram.js';
import { getSession, getUser } from '../src/store.js';
import { parseDateTime } from '../src/time.js';
import type { Env, ItemRow, NotificationRow, TaskRow, TelegramMessage, TelegramUpdate, TelegramUser } from '../src/types.js';
import { createTestDatabase } from './helpers/database.js';

const NOW = Date.UTC(2026, 9, 23, 12);
const ALICE: TelegramUser = { id: 1, first_name: 'Алиса', username: 'alice' };
const BOB: TelegramUser = { id: 2, first_name: 'Боб', username: 'bobob' };
const MEMBER: TelegramUser = { id: 3, first_name: 'Участник', username: 'member' };
type Sent = { chatId: number; text: string; extra: Record<string, any> };

function harness(seed = '1') {
  const storage = createTestDatabase();
  const sent: Sent[] = [];
  const telegram = new TelegramApi('test');
  telegram.sendMessage = async (chatId, text, extra = {}) => { sent.push({ chatId, text, extra }); return { message_id: sent.length, chat: { id: chatId, type: 'private' }, text }; };
  telegram.answerCallbackQuery = async () => true;
  const env: Env = { DB: storage.binding, TELEGRAM_BOT_TOKEN: 'test', WEBHOOK_SECRET: 'test', BOOTSTRAP_ORG_IDS: seed, TIMEZONE: 'Europe/Moscow' };
  let sequence = 1;
  async function send(from: TelegramUser, text?: string, extra: Partial<TelegramMessage> = {}) {
    const update: TelegramUpdate = { update_id: sequence++, message: { message_id: sequence, chat: { id: from.id, type: 'private' }, from, ...(text ? { text } : {}), ...extra } };
    await handleUpdate(update, env, storage.db, telegram, NOW);
    return update.message!;
  }
  async function press(from: TelegramUser, data: string) {
    await handleUpdate({ update_id: sequence++, callback_query: { id: String(sequence), from, data, message: { message_id: sequence, chat: { id: from.id, type: 'private' } } } }, env, storage.db, telegram, NOW);
  }
  async function choice(from: TelegramUser, value: string) {
    const session = await getSession(storage.db, from.id, NOW);
    assert.ok(session, 'form session exists');
    const data = JSON.parse(session.data) as { token: string };
    await press(from, `f:${data.token}:${value}`);
  }
  async function knownUsers() { for (const user of [ALICE, BOB, MEMBER]) await send(user, '/start'); await storage.db.run("UPDATE users SET role='org' WHERE id=?", [BOB.id]); }
  async function event(title = 'Вечер Геншина') {
    await send(ALICE, '➕ Мероприятие');
    await send(ALICE, title);
    await choice(ALICE, 'ready');
    await send(ALICE, '10.11.2026 19:00');
    await choice(ALICE, 'public');
    await send(ALICE, '@alice @bobob');
    await send(ALICE, 'Покровка, 42');
    const item = await storage.db.get<ItemRow>('SELECT * FROM items WHERE title=?', [title]);
    assert.ok(item);
    return item;
  }
  return { ...storage, sent, telegram, env, send, press, choice, knownUsers, event };
}

test('participant cannot read internal cards, task IDs or mutate with old organizer callbacks', async () => {
  const h = harness();
  try {
    await h.knownUsers();
    const item = await h.event('Секретная встреча');
    const memberStart = h.sent.length;
    await h.press(MEMBER, `item:${item.id}`);
    await h.press(MEMBER, `edit:${item.id}`);
    await h.press(MEMBER, `publish:${item.id}:1`);
    await h.send(MEMBER, '📅 Расписание');
    assert.ok(h.sent.slice(memberStart).every(m => !m.text.includes('Секретная встреча')));
    assert.equal((await h.db.get<ItemRow>('SELECT * FROM items WHERE id=?', [item.id]))?.published, 0);

    await h.press(BOB, `ie:${item.id}:title`);
    await h.db.run("UPDATE users SET role='member' WHERE id=?", [BOB.id]);
    await h.send(BOB, 'Взломанное название');
    assert.equal((await h.db.get<ItemRow>('SELECT * FROM items WHERE id=?', [item.id]))?.title, 'Секретная встреча');
    assert.equal(await getSession(h.db, BOB.id, NOW), null);
  } finally { h.close(); }
});

test('event wizard survives calls, keeps drafts hidden, supports multiple assignees and forwarded registration post', async () => {
  const h = harness();
  try {
    await h.knownUsers();
    await h.send(ALICE, '➕ Мероприятие');
    await h.send(ALICE, 'Встреча ВШГ');
    const oldSession = await getSession(h.db, ALICE.id, NOW);
    const oldToken = JSON.parse(oldSession!.data).token;
    await h.choice(ALICE, 'ready');
    await h.press(ALICE, `f:${oldToken}:idea`);
    assert.equal((await getSession(h.db, ALICE.id, NOW))?.step, 'start_at');
    await h.send(ALICE, '31.11.2026 19:00');
    assert.equal((await getSession(h.db, ALICE.id, NOW))?.step, 'start_at');
    await h.send(ALICE, '10.11.2026 19:00');
    await h.choice(ALICE, 'public');
    await h.send(ALICE, '@alice, @bobob');
    await h.send(ALICE, 'Покровка');
    const item = await h.db.get<ItemRow>("SELECT * FROM items WHERE title='Встреча ВШГ'");
    assert.ok(item);
    assert.equal(item.published, 0);
    assert.equal(await getSession(h.db, ALICE.id, NOW), null);
    assert.equal((await h.db.all('SELECT * FROM item_assignees WHERE item_id=?', [item.id])).length, 2);
    await h.press(ALICE, `ie:${item.id}:alert`);
    await h.send(ALICE, 'https://example.org/malicious');
    assert.equal((await getSession(h.db, ALICE.id, NOW))?.step, 'post_url');
    await h.send(ALICE, undefined, { forward_origin: { type: 'channel', chat: { id: -1001234, type: 'channel', username: 'hsegenshin' }, message_id: 77 } });
    assert.equal((await getSession(h.db, ALICE.id, NOW))?.step, 'registration_deadline');
    await h.send(ALICE, '09.11.2026 20:00');
    const updated = await h.db.get<ItemRow>('SELECT * FROM items WHERE id=?', [item.id]);
    assert.equal(updated?.post_url, 'https://t.me/hsegenshin/77');
    assert.equal(updated?.registration_deadline, parseDateTime('09.11.2026 20:00'));
    assert.equal(updated?.published, 0);

    await h.press(ALICE, `publish:${item.id}:1`);
    await h.press(ALICE, `publish:${item.id}:1`);
    assert.equal((await h.db.get<ItemRow>('SELECT * FROM items WHERE id=?', [item.id]))?.revision, updated!.revision + 1, 'repeated callback does not toggle publication or revision');
    const first = h.sent.length;
    await h.press(MEMBER, `item:${item.id}`);
    const publicCard = h.sent.slice(first).map(m => m.text).join('\n');
    assert.match(publicCard, /Встреча ВШГ/);
    assert.ok(!publicCard.includes('@alice') && !publicCard.includes('Ответственные'));
    for (const message of h.sent) for (const row of message.extra.reply_markup?.inline_keyboard ?? []) for (const button of row) if (button.callback_data) assert.ok(Buffer.byteLength(button.callback_data) <= 64, button.callback_data);
  } finally { h.close(); }
});

test('task and one-level subtask forms accept optional deadline; completion and access changes are safe', async () => {
  const h = harness();
  try {
    await h.knownUsers();
    const item = await h.event();
    await h.press(ALICE, `newtask:${item.id}`);
    await h.send(ALICE, 'Подготовить квиз');
    await h.choice(ALICE, 'self');
    await h.choice(ALICE, 'skip');
    const parent = await h.db.get<TaskRow>("SELECT * FROM tasks WHERE title='Подготовить квиз'");
    assert.ok(parent);
    assert.equal(parent.due_at, null);
    assert.ok(h.sent.some(m => m.text.includes('10.11.2026') && m.text.includes('по дате мероприятия')));
    await h.press(ALICE, `subtask:${parent.id}`);
    await h.send(ALICE, 'Выбрать вопросы');
    await h.send(ALICE, '@alice @bobob');
    await h.send(ALICE, '08.11.2026 12:30');
    const child = await h.db.get<TaskRow>("SELECT * FROM tasks WHERE title='Выбрать вопросы'");
    assert.ok(child);
    assert.equal(child.parent_id, parent.id);
    assert.equal(child.due_at, parseDateTime('08.11.2026 12:30'));
    assert.equal((await h.db.all('SELECT * FROM task_assignees WHERE task_id=?', [child.id])).length, 2);
    await h.press(ALICE, `subtask:${child.id}`);
    assert.equal(await getSession(h.db, ALICE.id, NOW), null);
    await h.press(ALICE, `te:${child.id}:due_at`);
    await h.choice(ALICE, 'skip');
    assert.equal((await h.db.get<TaskRow>('SELECT * FROM tasks WHERE id=?', [child.id]))?.due_at, null);
    const before = (await h.db.get<TaskRow>('SELECT * FROM tasks WHERE id=?', [child.id]))!;
    await h.press(ALICE, `taskdone:${child.id}:done`);
    await h.press(ALICE, `taskdone:${child.id}:done`);
    const done = (await h.db.get<TaskRow>('SELECT * FROM tasks WHERE id=?', [child.id]))!;
    assert.equal(done.status, 'done');
    assert.equal(done.revision, before.revision + 1);
    const start = h.sent.length;
    await h.press(MEMBER, `task:${child.id}`);
    assert.ok(h.sent.slice(start).every(m => !m.text.includes('Выбрать вопросы')));
  } finally { h.close(); }
});

test('suggestions enqueue original media and author atomically into configured forum topic', async () => {
  const h = harness();
  try {
    await h.knownUsers();
    await h.send(ALICE, '/suggestionschat', { chat: { id: -100999, type: 'supergroup', title: 'Орги' }, message_thread_id: 42 });
    await h.send(MEMBER, '💡 Предложить идею');
    const source = await h.send(MEMBER, undefined, { photo: [{ file_id: 'photo' }], caption: 'Давайте сыграем!' });
    const suggestions = await h.db.all('SELECT * FROM suggestions');
    const jobs = await h.db.all<NotificationRow>("SELECT * FROM notifications WHERE kind='suggestion'");
    assert.equal(suggestions.length, 1);
    assert.equal(jobs.length, 1);
    const payload = JSON.parse(jobs[0].payload);
    assert.equal(payload.method, 'copyMessage');
    assert.equal(payload.body.chat_id, -100999);
    assert.equal(payload.body.message_thread_id, 42);
    assert.equal(payload.body.from_chat_id, MEMBER.id);
    assert.equal(payload.body.message_id, source.message_id);
    assert.equal(payload.body.reply_markup.inline_keyboard[0][0].url, `tg://user?id=${MEMBER.id}`);
    assert.equal((await h.db.get<{ org_only: number }>('SELECT org_only FROM groups WHERE chat_id=?', [-100999]))?.org_only, 1);
    assert.equal(await getSession(h.db, MEMBER.id, NOW), null);
  } finally { h.close(); }
});

test('role changes require known users, protect bootstrap and last org; only private interaction activates DMs', async () => {
  const h = harness('');
  try {
    await h.knownUsers();
    await h.db.run("UPDATE users SET role='org' WHERE id=?", [ALICE.id]);
    await h.press(ALICE, 'role:add');
    await h.send(ALICE, '@unknown');
    assert.ok(await getSession(h.db, ALICE.id, NOW));
    await h.send(ALICE, '@member');
    assert.equal((await getUser(h.db, MEMBER.id))?.role, 'org');
    await h.press(ALICE, 'role:remove');
    await h.send(ALICE, '@member');
    assert.equal((await getUser(h.db, MEMBER.id))?.role, 'member');
    await h.db.run("UPDATE users SET role='member' WHERE id=?", [BOB.id]);
    await h.press(ALICE, 'role:remove');
    await h.send(ALICE, '@alice');
    assert.equal((await getUser(h.db, ALICE.id))?.role, 'org');
    assert.ok(h.sent.some(m => m.text.includes('последнего организатора')));
    const unknown: TelegramUser = { id: 888, first_name: 'Гость' };
    await h.send(unknown, '/id', { chat: { id: -333, type: 'group' } });
    assert.equal((await getUser(h.db, unknown.id))?.dm_active, 0);
    await h.send(unknown, '/start');
    assert.equal((await getUser(h.db, unknown.id))?.dm_active, 1);
  } finally { h.close(); }
});

test('public group lifecycle ignores channels and preserves internal exclusion', async () => {
  const h = harness();
  try {
    await h.send(ALICE, '/start');
    const update = (id: number, type: 'supergroup' | 'channel', status: string): TelegramUpdate => ({ update_id: 100, my_chat_member: { chat: { id, type, title: 'Беседа' }, from: ALICE, new_chat_member: { status, user: { id: 999, first_name: 'Бот', is_bot: true } } } });
    await handleUpdate(update(-100222, 'channel', 'administrator'), h.env, h.db, h.telegram, NOW);
    assert.equal((await h.db.all('SELECT * FROM groups')).length, 0);
    await handleUpdate(update(-100333, 'supergroup', 'member'), h.env, h.db, h.telegram, NOW);
    assert.equal((await h.db.get<{ enabled: number }>('SELECT enabled FROM groups WHERE chat_id=?', [-100333]))?.enabled, 1);
    await h.send(ALICE, '/orgchat', { chat: { id: -100333, type: 'supergroup' }, message_thread_id: 7 });
    await handleUpdate(update(-100333, 'supergroup', 'member'), h.env, h.db, h.telegram, NOW);
    assert.equal((await h.db.get<{ org_only: number }>('SELECT org_only FROM groups WHERE chat_id=?', [-100333]))?.org_only, 1);
    await handleUpdate(update(-100333, 'supergroup', 'kicked'), h.env, h.db, h.telegram, NOW);
    assert.equal((await h.db.get<{ enabled: number }>('SELECT enabled FROM groups WHERE chat_id=?', [-100333]))?.enabled, 0);
  } finally { h.close(); }
});

test('significant posts stay internal, idea dates are optional and form cancellation loses no existing card', async () => {
  const h = harness();
  try {
    await h.knownUsers();
    await h.send(ALICE, '📝 Значимый пост');
    await h.send(ALICE, 'Анонс турнира');
    await h.choice(ALICE, 'idea');
    await h.choice(ALICE, 'skip');
    await h.choice(ALICE, 'self');
    const post = await h.db.get<ItemRow>("SELECT * FROM items WHERE title='Анонс турнира'");
    assert.ok(post);
    assert.equal(post.kind, 'post');
    assert.equal(post.start_at, null);
    assert.equal(post.visibility, 'private');
    await h.press(ALICE, `ie:${post.id}:alert`);
    await h.send(ALICE, 'https://t.me/hsegenshin/111?single');
    assert.equal((await h.db.get<ItemRow>('SELECT * FROM items WHERE id=?', [post.id]))?.post_url, 'https://t.me/hsegenshin/111');
    assert.equal(await getSession(h.db, ALICE.id, NOW), null);
    await h.press(ALICE, `ie:${post.id}:title`);
    await h.send(ALICE, '/cancel');
    assert.equal((await h.db.get<ItemRow>('SELECT * FROM items WHERE id=?', [post.id]))?.title, 'Анонс турнира');
    const first = h.sent.length;
    await h.press(MEMBER, `item:${post.id}`);
    assert.ok(h.sent.slice(first).every(m => !m.text.includes('Анонс турнира')));
    await h.press(ALICE, 'role:remove');
    await h.send(ALICE, '@alice');
    assert.equal((await getUser(h.db, ALICE.id))?.role, 'org');
    assert.ok(h.sent.some(m => m.text.includes('BOOTSTRAP_ORG_IDS')));
  } finally { h.close(); }
});

test('prototype property text is harmless and advertised slash commands work', async () => {
  const h = harness();
  try {
    await h.knownUsers();
    for (const text of ['__proto__', 'constructor', 'toString']) await h.send(MEMBER, text);
    assert.ok(h.sent.some(m => m.text.includes('Выберите действие в меню')));
    await h.send(MEMBER, '/subscribe');
    assert.equal((await getUser(h.db, MEMBER.id))?.subscribed, 1);
    await h.send(MEMBER, '/unsubscribe');
    assert.equal((await getUser(h.db, MEMBER.id))?.subscribed, 0);
    await h.send(MEMBER, '/calendar');
    assert.match(h.sent.at(-1)!.text, /Публичные мероприятия/);
    await h.send(ALICE, '/suggestionschat', { chat: { id: -100999, type: 'supergroup' }, message_thread_id: 42 });
    await h.send(MEMBER, '/suggest');
    assert.equal((await getSession(h.db, MEMBER.id, NOW))?.flow, 'suggestion');
  } finally { h.close(); }
});

test('same text update retried after form advancement redraws the current question', async () => {
  const h = harness();
  try {
    await h.knownUsers();
    await h.send(ALICE, '➕ Мероприятие');
    const title: TelegramUpdate = { update_id: 777, message: { message_id: 777, from: ALICE, chat: { id: ALICE.id, type: 'private' }, text: 'Событие из повторного webhook' } };
    await handleUpdate(title, h.env, h.db, h.telegram, NOW);
    const first = await getSession(h.db, ALICE.id, NOW);
    assert.equal(first?.step, 'status');
    assert.equal(JSON.parse(first!.data).lastUpdateId, 777);
    await handleUpdate(title, h.env, h.db, h.telegram, NOW);
    const second = await getSession(h.db, ALICE.id, NOW);
    assert.deepEqual(second, first, 'the retry does not save a second transition');
    assert.equal(h.sent.at(-1)!.text, 'Выберите статус.');
    assert.equal((await h.db.all('SELECT * FROM items')).length, 0);
  } finally { h.close(); }
});

test('twenty assignees use bounded lookups and bulk writes within D1 Free query limits', async () => {
  const h = harness();
  try {
    await h.knownUsers();
    const users = Array.from({ length: 20 }, (_, i) => ({ id: 100 + i, first_name: `Орг ${i}`, username: `organizer${i}` }));
    for (const user of users) {
      await h.send(user, '/start');
      await h.db.run("UPDATE users SET role='org' WHERE id=?", [user.id]);
    }
    await h.send(ALICE, '➕ Мероприятие');
    await h.send(ALICE, 'Большая команда');
    await h.choice(ALICE, 'ready');
    await h.send(ALICE, '10.11.2026 19:00');
    await h.choice(ALICE, 'public');
    let queries = 0;
    const prepare = h.binding.prepare.bind(h.binding);
    h.binding.prepare = (sql: string) => { queries++; return prepare(sql); };
    await h.send(ALICE, users.map(user => `@${user.username}`).join(' '));
    assert.ok(queries <= 10, `assignee input used ${queries} SQL statements`);
    queries = 0;
    await h.send(ALICE, 'Москва');
    assert.ok(queries <= 20, `final form step used ${queries} SQL statements`);
    const item = await h.db.get<ItemRow>("SELECT * FROM items WHERE title='Большая команда'");
    assert.ok(item);
    assert.equal((await h.db.all('SELECT * FROM item_assignees WHERE item_id=?', [item.id])).length, 20);
  } finally { h.close(); }
});
