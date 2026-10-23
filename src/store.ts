import type { Database } from './db.js';
import type { SessionRow, TelegramUser, UserRow } from './types.js';

const SESSION_TTL = 24 * 60 * 60 * 1000;
const UPDATE_LEASE = 60 * 1000;

export async function upsertUser(
  db: Database, telegramUser: TelegramUser, bootstrapOrgIds: number[], now: number,
): Promise<UserRow> {
  const displayName = [telegramUser.first_name, telegramUser.last_name].filter(Boolean).join(' ').trim()
    || telegramUser.username || String(telegramUser.id);
  // Deployment seed IDs are authoritative, including users discovered before setup was complete.
  // For other users, refreshing their identity never changes a granted or revoked role.
  // An incoming group update must not opt a user into notifications or reactivate a blocked DM.
  const row = await db.get<UserRow>(`
    INSERT INTO users (id, username, display_name, role, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET
      username = excluded.username, display_name = excluded.display_name,
      role = CASE WHEN excluded.role = 'org' THEN 'org' ELSE users.role END,
      updated_at = excluded.updated_at
    RETURNING *
  `, [telegramUser.id, telegramUser.username ?? null, displayName,
    bootstrapOrgIds.includes(telegramUser.id) ? 'org' : 'member', now, now]);
  if (!row) throw new Error('User upsert returned no row');
  return row;
}

export function getUser(db: Database, id: number): Promise<UserRow | null> {
  return db.get<UserRow>('SELECT * FROM users WHERE id = ?', [id]);
}

export async function getSetting(db: Database, key: string): Promise<string | null> {
  const row = await db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key]);
  return row?.value ?? null;
}

export async function setSetting(db: Database, key: string, value: string): Promise<void> {
  await db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', [key, value]);
}

export function getSession(db: Database, userId: number, now: number): Promise<SessionRow | null> {
  // A single predicate also ensures an expired session cannot be returned during a concurrent refresh.
  return db.get<SessionRow>('SELECT * FROM sessions WHERE user_id = ? AND expires_at > ?', [userId, now]);
}

export async function putSession(
  db: Database, userId: number, flow: string, step: string, data: unknown, now: number,
): Promise<void> {
  const json = JSON.stringify(data);
  if (json === undefined) throw new TypeError('Session data must be JSON serializable');
  await db.run(`
    INSERT INTO sessions (user_id, flow, step, data, expires_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (user_id) DO UPDATE SET flow = excluded.flow, step = excluded.step,
      data = excluded.data, expires_at = excluded.expires_at, updated_at = excluded.updated_at
  `, [userId, flow, step, json, now + SESSION_TTL, now]);
}

export async function clearSession(db: Database, userId: number): Promise<void> {
  await db.run('DELETE FROM sessions WHERE user_id = ?', [userId]);
}

export function getItemAssignees(db: Database, itemId: string): Promise<UserRow[]> {
  return db.all<UserRow>(`
    SELECT u.* FROM users u JOIN item_assignees a ON a.user_id = u.id
    WHERE a.item_id = ? ORDER BY u.id
  `, [itemId]);
}

export function getTaskAssignees(db: Database, taskId: string): Promise<UserRow[]> {
  return db.all<UserRow>(`
    SELECT u.* FROM users u JOIN task_assignees a ON a.user_id = u.id
    WHERE a.task_id = ? ORDER BY u.id
  `, [taskId]);
}

export async function claimTelegramUpdate(
  db: Database, updateId: number, now: number,
): Promise<'claimed' | 'done' | 'busy'> {
  // The conditional upsert is atomic: two Worker requests cannot both acquire the same lease.
  const claimed = await db.get<{ update_id: number }>(`
    INSERT INTO telegram_updates (update_id, state, lease_until, attempts, received_at)
    VALUES (?, 'processing', ?, 1, ?)
    ON CONFLICT (update_id) DO UPDATE SET
      lease_until = excluded.lease_until, attempts = telegram_updates.attempts + 1
    WHERE telegram_updates.state = 'processing' AND telegram_updates.lease_until <= ?
    RETURNING update_id
  `, [updateId, now + UPDATE_LEASE, now, now]);
  if (claimed) return 'claimed';
  const existing = await db.get<{ state: string }>('SELECT state FROM telegram_updates WHERE update_id = ?', [updateId]);
  return existing?.state === 'done' ? 'done' : 'busy';
}

export async function finishTelegramUpdate(db: Database, updateId: number, now: number): Promise<void> {
  await db.run("UPDATE telegram_updates SET state = 'done', lease_until = ? WHERE update_id = ? AND state = 'processing'", [now, updateId]);
}

export async function releaseTelegramUpdate(db: Database, updateId: number): Promise<void> {
  // Keep the row and its attempt count for diagnosis; only processing rows can be retried.
  await db.run("UPDATE telegram_updates SET lease_until = 0 WHERE update_id = ? AND state = 'processing'", [updateId]);
}
