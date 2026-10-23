import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { Database } from '../src/db.js';
import {
  claimTelegramUpdate, clearSession, finishTelegramUpdate, getItemAssignees,
  getSession, getSetting, getTaskAssignees, getUser, putSession, releaseTelegramUpdate,
  setSetting, upsertUser,
} from '../src/store.js';
import { createTestDatabase } from './helpers/database.js';

const NOW = Date.UTC(2026, 9, 23, 12);

test('user identity refresh preserves permissions, subscription and blocked DM state', async t => {
  const { db, close } = createTestDatabase(); t.after(close);
  const first = await upsertUser(db, { id: 12, first_name: 'Тест', username: 'Alice' }, [12], NOW);
  assert.equal(first.role, 'org');
  assert.equal(first.dm_active, 0, 'a group-only encounter does not authorize private messages');
  await db.run("UPDATE users SET role = 'member', subscribed = 1 WHERE id = 12");
  const updated = await upsertUser(db, { id: 12, first_name: 'Алиса', last_name: 'Тестова' }, [], NOW + 1);
  assert.equal(updated.display_name, 'Алиса Тестова');
  assert.equal(updated.username, null);
  assert.equal(updated.role, 'member', 'a non-seed revocation remains in place');
  assert.equal(updated.subscribed, 1);
  assert.equal(updated.created_at, NOW);
  assert.equal(updated.updated_at, NOW + 1);
  assert.equal(await getUser(db, 999), null);
  assert.deepEqual(await getUser(db, 12), updated);
});

test('adding an already known member to deployment seed promotes them without resetting preferences', async t => {
  const { db, close } = createTestDatabase(); t.after(close);
  const member = await upsertUser(db, { id: 15, first_name: 'Будущий орг' }, [], NOW);
  assert.equal(member.role, 'member');
  await db.run('UPDATE users SET dm_active = 1, subscribed = 1 WHERE id = 15');
  const org = await upsertUser(db, { id: 15, first_name: 'Будущий орг' }, [15], NOW + 1);
  assert.equal(org.role, 'org');
  assert.equal(org.subscribed, 1);
  assert.equal(org.dm_active, 1);
  assert.equal(org.created_at, NOW);
});

test('settings distinguish absent values from empty topic values and safely bind text', async t => {
  const { db, close } = createTestDatabase(); t.after(close);
  assert.equal(await getSetting(db, 'org_thread_id'), null);
  await setSetting(db, 'org_thread_id', '');
  assert.equal(await getSetting(db, 'org_thread_id'), '');
  await setSetting(db, 'org_thread_id', '7');
  assert.equal(await getSetting(db, 'org_thread_id'), '7');
  await setSetting(db, "quoted'; DROP TABLE settings; --", "\"'; текст");
  assert.equal(await getSetting(db, "quoted'; DROP TABLE settings; --"), "\"'; текст");
});

test('forms persist through wrapper restart, expire exactly at 24 hours and refresh on input', async t => {
  const { db, binding, close } = createTestDatabase(); t.after(close);
  await upsertUser(db, { id: 1, first_name: 'Орг' }, [1], NOW);
  await putSession(db, 1, 'event', 'title', { title: 'Чай', emoji: '☕' }, NOW);
  const restarted = new Database(binding);
  assert.deepEqual(JSON.parse((await getSession(restarted, 1, NOW))!.data), { title: 'Чай', emoji: '☕' });
  const day = 24 * 60 * 60 * 1000;
  assert.ok(await getSession(restarted, 1, NOW + day - 1));
  assert.equal(await getSession(restarted, 1, NOW + day), null);
  await putSession(db, 1, 'event', 'time', { title: 'Чай' }, NOW + day);
  assert.equal((await getSession(db, 1, NOW + day))?.step, 'time');
  await clearSession(db, 1);
  assert.equal(await getSession(db, 1, NOW + day), null);
  await assert.rejects(putSession(db, 1, 'event', 'title', undefined, NOW), /JSON serializable/);
});

test('Telegram leases allow one claim, retry after expiration/release and preserve completed updates', async t => {
  const { db, close } = createTestDatabase(); t.after(close);
  assert.deepEqual(await Promise.all([
    claimTelegramUpdate(db, 7, NOW), claimTelegramUpdate(db, 7, NOW), claimTelegramUpdate(db, 7, NOW),
  ]), ['claimed', 'busy', 'busy']);
  assert.equal(await claimTelegramUpdate(db, 7, NOW + 59_999), 'busy');
  assert.equal(await claimTelegramUpdate(db, 7, NOW + 60_000), 'claimed');
  await releaseTelegramUpdate(db, 7);
  assert.equal(await claimTelegramUpdate(db, 7, NOW + 60_001), 'claimed');
  assert.equal((await db.get<{ attempts: number }>('SELECT attempts FROM telegram_updates WHERE update_id = 7'))?.attempts, 3);
  await finishTelegramUpdate(db, 7, NOW + 60_002);
  await releaseTelegramUpdate(db, 7);
  assert.equal(await claimTelegramUpdate(db, 7, NOW + 999_999), 'done');
});

async function seedItem(db: Database, id: string): Promise<void> {
  await db.run(`INSERT INTO items (id, kind, title, created_by, created_at, updated_at)
    VALUES (?, 'event', 'Ивент', 1, ?, ?)`, [id, NOW, NOW]);
}
async function seedTask(db: Database, id: string, item: string, parent: string | null = null): Promise<void> {
  await db.run(`INSERT INTO tasks (id, item_id, parent_id, title, created_by, created_at, updated_at)
    VALUES (?, ?, ?, 'Задание', 1, ?, ?)`, [id, item, parent, NOW, NOW]);
}

test('task hierarchy rejects cross-event children, deeper nesting, cycles and invalid parent edits', async t => {
  const { db, close } = createTestDatabase(); t.after(close);
  await upsertUser(db, { id: 1, first_name: 'Орг' }, [1], NOW);
  await seedItem(db, 'event1'); await seedItem(db, 'event2');
  await seedTask(db, 'parent', 'event1');
  await seedTask(db, 'child', 'event1', 'parent');
  await assert.rejects(seedTask(db, 'grandchild', 'event1', 'child'), /top-level/);
  await assert.rejects(seedTask(db, 'cross', 'event2', 'parent'), /same item/);
  await assert.rejects(db.run("UPDATE tasks SET parent_id = 'child' WHERE id = 'parent'"));
  await assert.rejects(db.run("UPDATE tasks SET item_id = 'event2' WHERE id = 'parent'"));
  await assert.rejects(db.run("UPDATE tasks SET parent_id = 'child' WHERE id = 'child'"));
  assert.equal((await db.get<{ item_id: string }>("SELECT item_id FROM tasks WHERE id = 'parent'"))?.item_id, 'event1');
});

test('assignments are stable, unique and cascade with an item including child tasks and notifications', async t => {
  const { db, close } = createTestDatabase(); t.after(close);
  await upsertUser(db, { id: 1, first_name: 'Первый' }, [1], NOW);
  await upsertUser(db, { id: 2, first_name: 'Второй' }, [2], NOW);
  await seedItem(db, 'event');
  await seedTask(db, 'task', 'event'); await seedTask(db, 'child', 'event', 'task');
  await db.run("INSERT INTO item_assignees (item_id, user_id) VALUES ('event', 2), ('event', 1)");
  await db.run("INSERT INTO task_assignees (task_id, user_id) VALUES ('child', 2)");
  assert.deepEqual((await getItemAssignees(db, 'event')).map(user => user.id), [1, 2]);
  assert.deepEqual((await getTaskAssignees(db, 'child')).map(user => user.id), [2]);
  await assert.rejects(db.run("INSERT INTO item_assignees (item_id, user_id) VALUES ('event', 2)"), /UNIQUE/);
  await db.run(`INSERT INTO notifications (id, dedupe_key, kind, item_id, task_id, chat_id, scheduled_at, payload, next_attempt_at, created_at)
    VALUES ('n', 'unique', 'task', 'event', 'child', 2, ?, '{}', ?, ?)`, [NOW, NOW, NOW]);
  await db.run("DELETE FROM items WHERE id = 'event'");
  assert.deepEqual(await db.all('SELECT * FROM tasks'), []);
  assert.deepEqual(await db.all('SELECT * FROM item_assignees'), []);
  assert.deepEqual(await db.all('SELECT * FROM task_assignees'), []);
  assert.deepEqual(await db.all('SELECT * FROM notifications'), []);
});

test('D1 batch rolls back all writes on a failed statement and SQL constraints reject invalid data', async t => {
  const { db, close } = createTestDatabase(); t.after(close);
  await assert.rejects(db.batch([
    { sql: "INSERT INTO settings (key, value) VALUES ('first', 'yes')" },
    { sql: "INSERT INTO settings (key, value) VALUES ('first', 'duplicate')" },
  ]), /UNIQUE/);
  assert.equal(await getSetting(db, 'first'), null);
  assert.deepEqual(await db.batch([]), []);
  await upsertUser(db, { id: 1, first_name: 'Орг' }, [1], NOW);
  await assert.rejects(db.run("UPDATE users SET role = 'admin' WHERE id = 1"), /CHECK/);
  await assert.rejects(db.run("INSERT INTO item_assignees (item_id, user_id) VALUES ('absent', 1)"), /FOREIGN KEY/);
  await assert.rejects(db.run("INSERT INTO sessions (user_id, flow, step, data, expires_at, updated_at) VALUES (1, 'x', 'y', 'not json', 2, 1)"), /CHECK/);
});

test('outbox migration preserves every field of existing jobs and accepts reply jobs with indexes and constraints', t => {
  const sqlite = new DatabaseSync(':memory:'); t.after(() => sqlite.close());
  sqlite.exec('PRAGMA foreign_keys=ON');
  sqlite.exec(readFileSync(fileURLToPath(new URL('../migrations/0001_initial.sql', import.meta.url).href), 'utf8'));
  sqlite.prepare(`INSERT INTO users(id,display_name,role,created_at,updated_at) VALUES(1,'Орг','org',?,?)`).run(NOW, NOW);
  sqlite.prepare(`INSERT INTO items(id,kind,title,created_by,created_at,updated_at) VALUES('event','event','Название',1,?,?)`).run(NOW, NOW);
  sqlite.prepare(`INSERT INTO tasks(id,item_id,title,created_by,created_at,updated_at) VALUES('task','event','Задание',1,?,?)`).run(NOW, NOW);
  sqlite.prepare(`INSERT INTO notifications (
    id,dedupe_key,kind,item_id,task_id,item_revision,task_revision,recipient_user_id,
    chat_id,thread_id,scheduled_at,expires_at,payload,state,attempts,next_attempt_at,
    locked_until,sent_at,telegram_message_id,last_error,created_at
  ) VALUES('old','unique','task','event','task',7,5,1,1,9,?,?,'{"method":"sendMessage","body":{"text":"Привет"}}','sent',3,?,null,?,45,'old error',?)`)
    .run(NOW, NOW + 1_000, NOW, NOW + 500, NOW - 500);
  const before = { ...sqlite.prepare("SELECT * FROM notifications WHERE id='old'").get() };
  sqlite.exec(readFileSync(fileURLToPath(new URL('../migrations/0002_reply_outbox.sql', import.meta.url).href), 'utf8'));
  assert.deepEqual({ ...sqlite.prepare("SELECT * FROM notifications WHERE id='old'").get() }, before);
  const indexes = sqlite.prepare('PRAGMA index_list(notifications)').all().map(row => row.name);
  for (const index of ['notifications_pending', 'notifications_lease', 'notifications_item', 'notifications_task', 'notifications_recipient', 'notifications_expiry']) assert.ok(indexes.includes(index));
  sqlite.prepare(`INSERT INTO notifications(id,dedupe_key,kind,chat_id,scheduled_at,payload,next_attempt_at,created_at)
    VALUES('reply','reply:42:0','reply',1,?,'{"method":"sendMessage","body":{"text":"Готово"}}',?,?)`).run(NOW, NOW, NOW);
  assert.throws(() => sqlite.prepare(`INSERT INTO notifications(id,dedupe_key,kind,chat_id,scheduled_at,payload,next_attempt_at,created_at)
    VALUES('duplicate','reply:42:0','reply',1,?,'{}',?,?)`).run(NOW, NOW, NOW), /UNIQUE/);
  assert.throws(() => sqlite.prepare("UPDATE notifications SET kind='unknown' WHERE id='reply'").run(), /CHECK/);
  sqlite.exec("DELETE FROM items WHERE id='event'");
  assert.equal(sqlite.prepare("SELECT * FROM notifications WHERE id='old'").get(), undefined);
});

test('suggestion-source migration safely collapses old duplicates and enforces source idempotency', t => {
  const sqlite = new DatabaseSync(':memory:'); t.after(() => sqlite.close());
  sqlite.exec('PRAGMA foreign_keys=ON');
  for (const name of ['0001_initial.sql', '0002_reply_outbox.sql']) {
    sqlite.exec(readFileSync(fileURLToPath(new URL(`../migrations/${name}`, import.meta.url).href), 'utf8'));
  }
  sqlite.prepare("INSERT INTO users(id,display_name,created_at,updated_at) VALUES(1,'Автор',?,?)").run(NOW, NOW);
  const insert = sqlite.prepare('INSERT INTO suggestions(id,user_id,chat_id,message_id,body_text,created_at) VALUES(?,1,1,?,?,?)');
  insert.run('first', 7, 'Оригинал', NOW);
  insert.run('duplicate', 7, 'Повтор', NOW + 1);
  insert.run('different', 8, 'Другое предложение', NOW + 2);
  sqlite.exec(readFileSync(fileURLToPath(new URL('../migrations/0003_unique_suggestion_source.sql', import.meta.url).href), 'utf8'));
  assert.deepEqual(sqlite.prepare('SELECT id FROM suggestions ORDER BY id').all().map(row => row.id), ['different', 'first']);
  assert.equal(sqlite.prepare("SELECT body_text FROM suggestions WHERE id='first'").get()?.body_text, 'Оригинал');
  assert.throws(() => insert.run('newduplicate', 7, 'Ещё повтор', NOW + 3), /UNIQUE/);
  assert.equal(sqlite.prepare("INSERT OR IGNORE INTO suggestions(id,user_id,chat_id,message_id,created_at) VALUES('ignored',1,1,7,?)").run(NOW).changes, 0);
});
