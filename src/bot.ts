import type { Database } from './db.js';
import { clearSession, getItemAssignees, getSession, getSetting, getTaskAssignees, getUser, putSession, upsertUser } from './store.js';
import type { Env, ItemRow, ItemStatus, SessionRow, TaskRow, TelegramMessage, TelegramUpdate, UserRow } from './types.js';
import type { TelegramApi } from './telegram.js';
import { formatDateTime, parseDateTime } from './time.js';

type Button = { text: string; callback_data?: string; url?: string };
type Keyboard = Button[][];
type Values = Record<string, unknown>;
type FormData = { token: string; values: Values; lastUpdateId?: number; itemId?: string; taskId?: string; parentId?: string | null; kind?: 'event' | 'post'; field?: string; action?: string };
type Context = { env: Env; db: Database; telegram: TelegramApi; now: number; updateId: number; user: UserRow; chatId: number };

const STATUSES: Record<ItemStatus, string> = { idea: 'Идея', development: 'В разработке', ready: 'Готов', done: 'Провели / опубликовано', cancelled: 'Отменено' };
const PAGE_SIZE = 8;
const LABELS = { public: '📅 Расписание', subscribe: '🔔 Подписка', suggest: '💡 Предложить идею', internal: '🗓 Для оргов', mine: '✅ Мои задания', event: '➕ Мероприятие', post: '📝 Значимый пост', roles: '👥 Организаторы', menu: '🏠 Меню' };
const cb = (text: string, callback_data: string): Button => ({ text, callback_data });
const short = (value: string, max = 55): string => value.length > max ? `${value.slice(0, max - 1)}…` : value;
const bootstraps = (env: Env): number[] => (env.BOOTSTRAP_ORG_IDS ?? '').split(/[\s,]+/).map(Number).filter(n => Number.isSafeInteger(n) && n > 0);
const timezone = (ctx: Context): string => ctx.env.TIMEZONE || 'Europe/Moscow';
const time = (ctx: Context, value: number | null): string => formatDateTime(value, timezone(ctx));
const mainButton = (): Button[] => [cb('🏠 Меню', 'menu')];

async function say(ctx: Context, text: string, keyboard?: Keyboard): Promise<void> {
  await ctx.telegram.sendMessage(ctx.chatId, text, keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {});
}

async function isOrg(ctx: Context): Promise<boolean> {
  const fresh = await getUser(ctx.db, ctx.user.id);
  if (fresh?.role === 'org') { ctx.user = fresh; ctx.telegram.markOrganizerContent(); return true; }
  await clearSession(ctx.db, ctx.user.id);
  await say(ctx, 'Это доступно организаторам. Откройте меню, чтобы продолжить.', [mainButton()]);
  return false;
}

async function menu(ctx: Context): Promise<void> {
  const user = await getUser(ctx.db, ctx.user.id);
  if (user?.role === 'org') ctx.telegram.markOrganizerContent();
  const keyboard: string[][] = [[LABELS.public, LABELS.subscribe], [LABELS.suggest]];
  if (user?.role === 'org') keyboard.push([LABELS.internal, LABELS.mine], [LABELS.event, LABELS.post], [LABELS.roles]);
  await ctx.telegram.sendMessage(ctx.chatId,
    'Высшая школа геншина\nВыберите действие. Даты и время — по Москве.\n\n/start — меню · /cancel — отменить форму · /id — ваш Telegram ID',
    { reply_markup: { keyboard: keyboard.map(row => row.map(text => ({ text }))), resize_keyboard: true } });
}

function monthKey(ctx: Context): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone(ctx), year: 'numeric', month: '2-digit' }).formatToParts(new Date(ctx.now));
  return `${parts.find(p => p.type === 'year')?.value}-${parts.find(p => p.type === 'month')?.value}`;
}

function adjacentMonth(month: string, delta: number): string {
  const [year, m] = month.split('-').map(Number);
  const date = new Date(Date.UTC(year, m - 1 + delta, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

async function calendar(ctx: Context, internal: boolean, month = monthKey(ctx), offset = 0): Promise<void> {
  if (internal && !await isOrg(ctx)) return;
  if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month) || !Number.isSafeInteger(offset) || offset < 0) return;
  const [year, m] = month.split('-');
  const next = adjacentMonth(month, 1).split('-');
  const start = parseDateTime(`01.${m}.${year} 00:00`, timezone(ctx));
  const end = parseDateTime(`01.${next[1]}.${next[0]} 00:00`, timezone(ctx));
  if (start === null || end === null) return;
  const mode = internal ? 'o' : 'p';
  const filter = internal ? '' : " AND kind='event' AND visibility='public' AND published=1";
  const rows = await ctx.db.all<ItemRow>(`SELECT * FROM items WHERE start_at>=? AND start_at<?${filter} ORDER BY start_at,id LIMIT ? OFFSET ?`, [start, end, PAGE_SIZE + 1, offset]);
  const shown = rows.slice(0, PAGE_SIZE);
  const heading = new Intl.DateTimeFormat('ru-RU', { timeZone: timezone(ctx), month: 'long', year: 'numeric' }).format(new Date(start));
  const keyboard: Keyboard = shown.map(item => [cb(`${item.kind === 'post' ? '📝' : item.visibility === 'private' || !item.published ? '🔒' : '🎉'} ${short(item.title, 38)} · ${time(ctx, item.start_at)}`, `item:${item.id}`)]);
  const pagination: Button[] = [];
  if (offset > 0) pagination.push(cb('← Страница', `cal:${mode}:${month}:${Math.max(0, offset - PAGE_SIZE)}`));
  if (rows.length > PAGE_SIZE) pagination.push(cb('Страница →', `cal:${mode}:${month}:${offset + PAGE_SIZE}`));
  if (pagination.length) keyboard.push(pagination);
  keyboard.push([cb('← Месяц', `cal:${mode}:${adjacentMonth(month, -1)}:0`), cb('Месяц →', `cal:${mode}:${adjacentMonth(month, 1)}:0`)]);
  if (internal) keyboard.push([cb('Идеи и карточки без даты', 'ideas:0')]);
  keyboard.push(mainButton());
  await say(ctx, `${internal ? 'Внутреннее расписание' : 'Публичные мероприятия'} · ${heading}\n${shown.length ? 'Выберите карточку:' : 'На этот месяц пока ничего нет.'}`, keyboard);
}

async function ideas(ctx: Context, offset = 0): Promise<void> {
  if (!await isOrg(ctx)) return;
  if (!Number.isSafeInteger(offset) || offset < 0) return;
  const rows = await ctx.db.all<ItemRow>('SELECT * FROM items WHERE start_at IS NULL ORDER BY created_at DESC,id LIMIT ? OFFSET ?', [PAGE_SIZE + 1, offset]);
  const keyboard: Keyboard = rows.slice(0, PAGE_SIZE).map(i => [cb(short(i.title), `item:${i.id}`)]);
  if (offset > 0) keyboard.push([cb('← Страница', `ideas:${Math.max(0, offset - PAGE_SIZE)}`)]);
  if (rows.length > PAGE_SIZE) keyboard.push([cb('Страница →', `ideas:${offset + PAGE_SIZE}`)]);
  keyboard.push(mainButton());
  await say(ctx, rows.length ? 'Карточки без даты:' : 'Карточек без даты пока нет.', keyboard);
}

async function itemForOrg(ctx: Context, id: string): Promise<ItemRow | null> {
  if (!await isOrg(ctx)) return null;
  const item = await ctx.db.get<ItemRow>('SELECT * FROM items WHERE id=?', [id]);
  if (!item) await say(ctx, 'Карточка не найдена.', [mainButton()]);
  return item;
}

async function showItem(ctx: Context, id: string): Promise<void> {
  const item = await ctx.db.get<ItemRow>('SELECT * FROM items WHERE id=?', [id]);
  const fresh = await getUser(ctx.db, ctx.user.id);
  const org = fresh?.role === 'org';
  if (org) ctx.telegram.markOrganizerContent();
  if (!item || (!org && !(item.kind === 'event' && item.published && item.visibility === 'public'))) {
    await say(ctx, 'Карточка недоступна.', [mainButton()]); return;
  }
  const lines = [`${item.kind === 'event' ? '🎉' : '📝'} ${item.title}`, `${item.kind === 'event' ? 'Когда' : 'Публикация'}: ${time(ctx, item.start_at)}`, `Статус: ${STATUSES[item.status]}`];
  if (item.location) lines.push(`Где: ${item.location}`);
  if (item.registration_deadline !== null) lines.push(`Регистрация до: ${time(ctx, item.registration_deadline)}`);
  if (item.post_url) lines.push(`Пост: ${item.post_url}`);
  const keyboard: Keyboard = [];
  if (org) {
    const assignees = await getItemAssignees(ctx.db, id);
    lines.push(`Видимость: ${item.visibility === 'public' ? 'публичное' : 'для оргов'}; ${item.published ? 'опубликовано в расписании' : 'скрыто из публичного расписания'}`, `Ответственные: ${assignees.length ? assignees.map(u => u.username ? `@${u.username}` : u.display_name).join(', ') : 'не назначены'}`);
    keyboard.push([cb('✏️ Изменить', `edit:${id}`), cb('📋 Задания', `tasks:${id}:0`)]);
    if (item.kind === 'event') keyboard.push([cb(item.published ? 'Скрыть из расписания' : 'Опубликовать в расписании', `publish:${id}:${item.published ? 0 : 1}`)]);
    keyboard.push([cb(item.kind === 'event' ? '🔔 Настроить регистрацию' : '🔗 Ссылка на пост', `ie:${id}:alert`)]);
  }
  if (item.post_url) keyboard.push([{ text: 'Открыть основной пост', url: item.post_url }]);
  keyboard.push(mainButton());
  await say(ctx, lines.join('\n'), keyboard);
}

async function editItemMenu(ctx: Context, id: string): Promise<void> {
  const item = await itemForOrg(ctx, id); if (!item) return;
  const keyboard: Keyboard = [
    [cb('Название', `ie:${id}:title`), cb('Дата и время', `ie:${id}:start_at`)],
    [cb('Статус', `ie:${id}:status`), cb('Ответственные', `ie:${id}:assignees`)]
  ];
  if (item.kind === 'event') keyboard.push([cb('Видимость', `ie:${id}:visibility`), cb('Локация', `ie:${id}:location`)]);
  if (item.registration_deadline !== null) keyboard.push([cb('Отключить алерт регистрации', `noalert:${id}`)]);
  keyboard.push([cb('← Карточка', `item:${id}`)]);
  await say(ctx, `Изменить «${item.title}»:`, keyboard);
}

async function subscription(ctx: Context, value?: boolean): Promise<void> {
  if (value !== undefined) await ctx.db.run('UPDATE users SET subscribed=?,updated_at=? WHERE id=?', [value ? 1 : 0, ctx.now, ctx.user.id]);
  const user = await getUser(ctx.db, ctx.user.id);
  await say(ctx, user?.subscribed ? '🔔 Вы подписаны на напоминания об окончании регистрации на все публичные мероприятия: за 72 и 24 часа.' : 'Напоминания в личку выключены. Можно подписаться на все публичные мероприятия.', [[cb(user?.subscribed ? 'Выключить напоминания' : 'Включить напоминания', user?.subscribed ? 'sub:off' : 'sub:on')], mainButton()]);
}

async function showTasks(ctx: Context, itemId: string, offset = 0): Promise<void> {
  const item = await itemForOrg(ctx, itemId); if (!item) return;
  if (!Number.isSafeInteger(offset) || offset < 0) return;
  const rows = await ctx.db.all<TaskRow>('SELECT * FROM tasks WHERE item_id=? ORDER BY COALESCE(parent_id,id),parent_id IS NOT NULL,created_at,id LIMIT ? OFFSET ?', [itemId, PAGE_SIZE + 1, offset]);
  const keyboard: Keyboard = rows.slice(0, PAGE_SIZE).map(t => [cb(`${t.status === 'done' ? '✅' : '▫️'} ${t.parent_id ? '↳ ' : ''}${short(t.title)}`, `task:${t.id}`)]);
  if (offset > 0) keyboard.push([cb('← Страница', `tasks:${itemId}:${Math.max(0, offset - PAGE_SIZE)}`)]);
  if (rows.length > PAGE_SIZE) keyboard.push([cb('Страница →', `tasks:${itemId}:${offset + PAGE_SIZE}`)]);
  keyboard.push([cb('➕ Задание', `newtask:${itemId}`)], [cb('← Карточка', `item:${itemId}`)]);
  await say(ctx, `Задания · ${item.title}\n${rows.length ? 'Выберите задание:' : 'Пока нет заданий.'}`, keyboard);
}

async function taskForOrg(ctx: Context, id: string): Promise<TaskRow | null> {
  if (!await isOrg(ctx)) return null;
  const task = await ctx.db.get<TaskRow>('SELECT * FROM tasks WHERE id=?', [id]);
  if (!task) await say(ctx, 'Задание не найдено.', [mainButton()]);
  return task;
}

async function showTask(ctx: Context, id: string): Promise<void> {
  const task = await taskForOrg(ctx, id); if (!task) return;
  const item = await ctx.db.get<ItemRow>('SELECT * FROM items WHERE id=?', [task.item_id]); if (!item) return;
  const assignees = await getTaskAssignees(ctx.db, id);
  const effective = task.due_at ?? item.start_at;
  const lines = [`${task.status === 'done' ? '✅' : '📌'} ${task.title}`, `Карточка: ${item.title}`, `Статус: ${task.status === 'done' ? 'выполнено' : 'открыто'}`, `Дедлайн: ${time(ctx, effective)}${task.due_at === null ? ` (по дате ${item.kind === 'event' ? 'мероприятия' : 'публикации'})` : ''}`, `Исполнители: ${assignees.length ? assignees.map(u => u.username ? `@${u.username}` : u.display_name).join(', ') : 'не назначены'}`];
  if (task.status === 'open' && effective !== null && effective < ctx.now) lines.push('⏰ Дедлайн прошёл.');
  const keyboard: Keyboard = [[cb(task.status === 'done' ? 'Вернуть в работу' : '✅ Выполнено', `taskdone:${id}:${task.status === 'open' ? 'done' : 'open'}`)], [cb('Текст', `te:${id}:title`), cb('Дедлайн', `te:${id}:due_at`), cb('Исполнители', `te:${id}:assignees`)]];
  if (!task.parent_id) keyboard.push([cb('➕ Подзадача', `subtask:${id}`)]);
  if (task.parent_id) keyboard.push([cb('↑ Родительское задание', `task:${task.parent_id}`)]);
  keyboard.push([cb('← Все задания', `tasks:${item.id}:0`)]);
  await say(ctx, lines.join('\n'), keyboard);
}

async function myTasks(ctx: Context, offset = 0): Promise<void> {
  if (!await isOrg(ctx)) return;
  if (!Number.isSafeInteger(offset) || offset < 0) return;
  const rows = await ctx.db.all<TaskRow & { effective_due: number | null }>(`SELECT t.*,COALESCE(t.due_at,i.start_at) AS effective_due FROM tasks t JOIN task_assignees a ON a.task_id=t.id JOIN items i ON i.id=t.item_id WHERE a.user_id=? AND t.status='open' AND i.status NOT IN ('done','cancelled') ORDER BY COALESCE(t.due_at,i.start_at,9223372036854775807),t.id LIMIT ? OFFSET ?`, [ctx.user.id, PAGE_SIZE + 1, offset]);
  const keyboard: Keyboard = rows.slice(0, PAGE_SIZE).map(t => [cb(`${t.effective_due !== null && t.effective_due < ctx.now ? '⏰ ' : ''}${short(t.title, 40)} · ${time(ctx, t.effective_due)}`, `task:${t.id}`)]);
  if (offset > 0) keyboard.push([cb('← Страница', `mine:${Math.max(0, offset - PAGE_SIZE)}`)]);
  if (rows.length > PAGE_SIZE) keyboard.push([cb('Страница →', `mine:${offset + PAGE_SIZE}`)]);
  keyboard.push(mainButton());
  await say(ctx, rows.length ? 'Ваши открытые задания:' : 'Открытых заданий на вас пока нет.', keyboard);
}

async function roles(ctx: Context): Promise<void> {
  if (!await isOrg(ctx)) return;
  const orgs = await ctx.db.all<UserRow>("SELECT * FROM users WHERE role='org' ORDER BY display_name,id LIMIT 100");
  await say(ctx, `Организаторы:\n${orgs.map(u => `${u.username ? `@${u.username}` : u.display_name} · ${u.id}`).join('\n')}\n\nДля поиска по @нику человек сначала должен написать боту /start. Все организаторы могут менять карточки и назначения.`, [[cb('Добавить организатора', 'role:add')], [cb('Снять роль организатора', 'role:remove')], mainButton()]);
}

function newData(extra: Partial<FormData> = {}): FormData {
  return { token: crypto.randomUUID().slice(0, 8), values: {}, ...extra };
}

const formButton = (data: FormData, text: string, action: string): Button => cb(text, `f:${data.token}:${action}`);

async function saveForm(ctx: Context, flow: string, step: string, data: FormData): Promise<void> {
  // A new token per step prevents a previous screen's "skip" from changing the current field.
  data.token = crypto.randomUUID().slice(0, 8);
  // A retried Telegram update must not be consumed again by the following form step.
  data.lastUpdateId = ctx.updateId;
  await putSession(ctx.db, ctx.user.id, flow, step, data, ctx.now);
  await prompt(ctx, flow, step, data);
}

async function prompt(ctx: Context, flow: string, step: string, data: FormData): Promise<void> {
  const keyboard: Keyboard = [];
  let text = '';
  if (step === 'title') text = flow.includes('task') ? 'Напишите конкретное задание (до 1000 символов).' : 'Как называется карточка? До 200 символов.';
  if (step === 'status') {
    text = 'Выберите статус.';
    keyboard.push(...Object.entries(STATUSES).map(([value, label]) => [formButton(data, label, value)]));
  }
  if (step === 'start_at') {
    text = `Укажите ${data.kind === 'post' ? 'планируемую публикацию' : 'дату и время мероприятия'}: ДД.ММ.ГГГГ ЧЧ:ММ, по Москве.\nНапример: 30.10.2026 19:00.`;
    if (data.values.status === 'idea') keyboard.push([formButton(data, 'Пока без даты', 'skip')]);
  }
  if (step === 'due_at') {
    text = 'Дедлайн задания: ДД.ММ.ГГГГ ЧЧ:ММ, по Москве.\nМожно оставить без собственного дедлайна: тогда напоминания привязаны к дате мероприятия или публикации поста.';
    keyboard.push([formButton(data, 'По дате мероприятия / поста', 'skip')]);
  }
  if (step === 'visibility') { text = 'Кому доступно мероприятие? Даже публичная карточка появится у участников только после кнопки «Опубликовать в расписании».'; keyboard.push([formButton(data, 'Всем', 'public'), formButton(data, 'Только оргам', 'private')]); }
  if (step === 'assignees') {
    text = 'Отправьте @ники ответственных через пробел или запятую. Назначать можно организаторов, которые уже запустили бота.\nМожно написать «я» вместе с другими @никами.';
    keyboard.push([formButton(data, 'Назначить себя', 'self'), formButton(data, 'Пока без ответственных', 'skip')]);
  }
  if (step === 'location') { text = 'Где состоится мероприятие? Адрес, аудитория или онлайн-ссылка (до 500 символов).'; keyboard.push([formButton(data, 'Пока без локации', 'skip')]); }
  if (step === 'post_url') text = data.kind === 'event' ? 'Перешлите публикацию из основного канала или отправьте ссылку на неё: https://t.me/канал/123.\nСледующим шагом укажем окончание регистрации.' : 'Перешлите опубликованный пост из канала или отправьте ссылку: https://t.me/канал/123.';
  if (step === 'registration_deadline') text = 'Когда заканчивается регистрация? ДД.ММ.ГГГГ ЧЧ:ММ, по Москве.\nУчастникам и публичным группам придут напоминания за 72 и 24 часа. Алерт работает только у опубликованного публичного мероприятия.';
  if (step === 'user') text = `${data.action === 'remove' ? 'У кого снять роль организатора' : 'Кого сделать организатором'}? Отправьте @ник или Telegram ID. Человек сначала должен запустить бота.`;
  if (step === 'content') text = 'Отправьте предложение одним сообщением: текст, фото, видео, документ, голосовое или стикер. Оно попадёт в тему предложений у оргов, вместе с вашим именем.\nДля альбома отправьте одно фото с описанием или отдельные сообщения через новые предложения.';
  keyboard.push([formButton(data, 'Отмена', 'cancel')]);
  await say(ctx, text, keyboard);
}

async function beginItem(ctx: Context, kind: 'event' | 'post'): Promise<void> {
  if (!await isOrg(ctx)) return;
  await saveForm(ctx, 'create_item', 'title', newData({ kind, itemId: crypto.randomUUID() }));
}

async function beginEditItem(ctx: Context, id: string, field: string): Promise<void> {
  const item = await itemForOrg(ctx, id); if (!item) return;
  if (!['title', 'start_at', 'visibility', 'status', 'assignees', 'location', 'alert'].includes(field)) return;
  if (item.kind === 'post' && ['visibility', 'location'].includes(field)) return;
  const data = newData({ kind: item.kind, itemId: id, field, values: { status: item.status, start_at: item.start_at } });
  await saveForm(ctx, 'edit_item', field === 'alert' ? 'post_url' : field, data);
}

async function beginTask(ctx: Context, itemId: string, parentId: string | null = null): Promise<void> {
  const item = await itemForOrg(ctx, itemId); if (!item) return;
  if (parentId) {
    const parent = await ctx.db.get<TaskRow>('SELECT * FROM tasks WHERE id=? AND item_id=?', [parentId, itemId]);
    if (!parent || parent.parent_id) { await say(ctx, 'Подзадача может быть только у основного задания.'); return; }
  }
  await saveForm(ctx, 'create_task', 'title', newData({ itemId, parentId, taskId: crypto.randomUUID() }));
}

async function beginEditTask(ctx: Context, id: string, field: string): Promise<void> {
  const task = await taskForOrg(ctx, id); if (!task || !['title', 'due_at', 'assignees'].includes(field)) return;
  await saveForm(ctx, 'edit_task', field, newData({ taskId: id, itemId: task.item_id, field }));
}

async function resolveAssignees(ctx: Context, input: string): Promise<number[] | null> {
  const tokens = input.trim().split(/[\s,;]+/).filter(Boolean);
  if (!tokens.length || tokens.length > 20) { await say(ctx, 'Укажите от 1 до 20 ответственных или нажмите «Пока без ответственных».'); return null; }
  const usernames = new Set<string>();
  let self = false;
  for (const token of tokens) {
    if (/^(я|себя)$/i.test(token)) self = true;
    else if (/^@?[A-Za-z][A-Za-z0-9_]{3,31}$/.test(token)) usernames.add(token.replace(/^@/, '').toLowerCase());
    else { await say(ctx, `Не понял «${short(token)}». Нужен @ник или «я».`); return null; }
  }
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  if (self) { conditions.push('id=?'); params.push(ctx.user.id); }
  if (usernames.size) { conditions.push(`lower(username) IN (${[...usernames].map(() => '?').join(',')})`); params.push(...usernames); }
  const users = await ctx.db.all<UserRow>(`SELECT * FROM users WHERE ${conditions.join(' OR ')}`, params);
  const byName = new Map(users.filter(u => u.username).map(u => [u.username!.toLowerCase(), u]));
  const ids = new Set<number>();
  for (const token of tokens) {
    const user = /^(я|себя)$/i.test(token) ? users.find(u => u.id === ctx.user.id) : byName.get(token.replace(/^@/, '').toLowerCase());
    if (!user || user.role !== 'org') { await say(ctx, `«${short(token)}» не найден среди организаторов. Сначала человек должен запустить бота и получить роль организатора.`); return null; }
    ids.add(user.id);
  }
  return [...ids];
}

async function assigneesStillOrgs(ctx: Context, ids: number[]): Promise<boolean> {
  if (!ids.length) return true;
  const rows = await ctx.db.all<{ id: number }>(`SELECT id FROM users WHERE role='org' AND id IN (${ids.map(() => '?').join(',')})`, ids);
  return rows.length === new Set(ids).size;
}

function assignmentInsert(kind: 'item' | 'task', entityId: string, ids: number[], ignore = false): { sql: string; params: (string | number)[] }[] {
  if (!ids.length) return [];
  // kind is an internal union, never text from the user; all values remain bound parameters.
  return [{ sql: `INSERT ${ignore ? 'OR IGNORE ' : ''}INTO ${kind}_assignees(${kind}_id,user_id) VALUES ${ids.map(() => '(?,?)').join(',')}`, params: ids.flatMap(id => [entityId, id]) }];
}

function postUrl(message: TelegramMessage): string | null {
  const origin = message.forward_origin;
  if (origin?.type === 'channel' && origin.chat && origin.message_id) {
    if (origin.chat.username && /^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(origin.chat.username)) return `https://t.me/${origin.chat.username}/${origin.message_id}`;
    const raw = String(origin.chat.id);
    if (/^-100\d+$/.test(raw)) return `https://t.me/c/${raw.slice(4)}/${origin.message_id}`;
  }
  const value = message.text?.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 't.me' || url.username || url.password || url.port) return null;
    if (!/^\/(?:[A-Za-z][A-Za-z0-9_]{3,31}|c\/\d+)\/[1-9]\d*\/?$/.test(url.pathname)) return null;
    return `https://t.me${url.pathname.replace(/\/$/, '')}`;
  } catch { return null; }
}

async function finishItem(ctx: Context, flow: string, data: FormData): Promise<void> {
  if (!await isOrg(ctx)) return;
  const v = data.values;
  const ids = Array.isArray(v.assignees) ? v.assignees as number[] : [];
  // Recheck assignments as roles may have changed while a saved form was open.
  if (!await assigneesStillOrgs(ctx, ids)) { await say(ctx, 'Один из ответственных больше не организатор. Выберите ответственных заново.'); await saveForm(ctx, flow, 'assignees', data); return; }
  let id = data.itemId;
  if (flow === 'create_item') {
    id ??= crypto.randomUUID();
    await ctx.db.batch([
      { sql: 'INSERT OR IGNORE INTO items(id,kind,title,start_at,visibility,status,location,published,created_by,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,0,?,1,?,?)', params: [id, data.kind!, v.title as string, (v.start_at as number | null) ?? null, data.kind === 'post' ? 'private' : v.visibility as string, v.status as string, (v.location as string | null) ?? null, ctx.user.id, ctx.now, ctx.now] },
      ...assignmentInsert('item', id!, ids, true)
    ]);
  } else {
    const item = await itemForOrg(ctx, id!); if (!item) return;
    const field = data.field!;
    if (field === 'assignees') await ctx.db.batch([
      { sql: 'DELETE FROM item_assignees WHERE item_id=?', params: [id!] },
      ...assignmentInsert('item', id!, ids),
      { sql: 'UPDATE items SET revision=revision+1,updated_at=? WHERE id=?', params: [ctx.now, id!] }
    ]);
    else if (field === 'alert') await ctx.db.run('UPDATE items SET post_url=?,registration_deadline=?,revision=revision+1,updated_at=? WHERE id=?', [v.post_url as string, data.kind === 'event' ? v.registration_deadline as number : item.registration_deadline, ctx.now, id!]);
    else if (field === 'status') {
      if (v.status !== 'idea' && item.start_at === null) {
        await say(ctx, 'Сначала задайте дату и время. Без даты карточка может оставаться идеей.');
        await clearSession(ctx.db, ctx.user.id); await showItem(ctx, id!); return;
      }
      await ctx.db.run('UPDATE items SET status=?,revision=revision+1,updated_at=? WHERE id=?', [v.status as string, ctx.now, id!]);
    } else if (field === 'start_at') {
      if (v.start_at === null && item.status !== 'idea') { await clearSession(ctx.db, ctx.user.id); await say(ctx, 'Статус карточки изменился. Без даты может оставаться только идея.'); await showItem(ctx, id!); return; }
      await ctx.db.run('UPDATE items SET start_at=?,revision=revision+1,updated_at=? WHERE id=?', [v.start_at as number | null, ctx.now, id!]);
    }
    else if (field === 'title') await ctx.db.run('UPDATE items SET title=?,revision=revision+1,updated_at=? WHERE id=?', [v.title as string, ctx.now, id!]);
    else if (field === 'visibility') await ctx.db.run('UPDATE items SET visibility=?,published=0,revision=revision+1,updated_at=? WHERE id=?', [v.visibility as string, ctx.now, id!]);
    else if (field === 'location') await ctx.db.run('UPDATE items SET location=?,revision=revision+1,updated_at=? WHERE id=?', [v.location as string | null, ctx.now, id!]);
  }
  await clearSession(ctx.db, ctx.user.id);
  await say(ctx, flow === 'create_item' ? 'Карточка создана и пока видна только оргам. Назначенные ответственные будут получать организационные напоминания.' : 'Изменения сохранены.');
  await showItem(ctx, id!);
}

async function finishTask(ctx: Context, flow: string, data: FormData): Promise<void> {
  if (!await isOrg(ctx)) return;
  const item = await ctx.db.get<ItemRow>('SELECT * FROM items WHERE id=?', [data.itemId!]); if (!item) { await clearSession(ctx.db, ctx.user.id); await say(ctx, 'Карточка уже удалена.'); return; }
  const ids = Array.isArray(data.values.assignees) ? data.values.assignees as number[] : [];
  if (!await assigneesStillOrgs(ctx, ids)) { await say(ctx, 'Один из исполнителей больше не организатор. Выберите исполнителей заново.'); await saveForm(ctx, flow, 'assignees', data); return; }
  let id = data.taskId;
  if (flow === 'create_task') {
    if (data.parentId) {
      const parent = await ctx.db.get<TaskRow>('SELECT * FROM tasks WHERE id=? AND item_id=?', [data.parentId, data.itemId!]);
      if (!parent || parent.parent_id) { await clearSession(ctx.db, ctx.user.id); await say(ctx, 'Родительское задание недоступно.'); return; }
    }
    id ??= crypto.randomUUID();
    await ctx.db.batch([
      { sql: "INSERT OR IGNORE INTO tasks(id,item_id,parent_id,title,due_at,status,created_by,revision,created_at,updated_at) VALUES(?,?,?,?,?,'open',?,1,?,?)", params: [id, data.itemId!, data.parentId ?? null, data.values.title as string, (data.values.due_at as number | null) ?? null, ctx.user.id, ctx.now, ctx.now] },
      ...assignmentInsert('task', id!, ids, true)
    ]);
  } else {
    const task = await taskForOrg(ctx, id!); if (!task) return;
    if (data.field === 'assignees') await ctx.db.batch([
      { sql: 'DELETE FROM task_assignees WHERE task_id=?', params: [id!] },
      ...assignmentInsert('task', id!, ids),
      { sql: 'UPDATE tasks SET revision=revision+1,updated_at=? WHERE id=?', params: [ctx.now, id!] }
    ]);
    else if (data.field === 'title') await ctx.db.run('UPDATE tasks SET title=?,revision=revision+1,updated_at=? WHERE id=?', [data.values.title as string, ctx.now, id!]);
    else if (data.field === 'due_at') await ctx.db.run('UPDATE tasks SET due_at=?,revision=revision+1,updated_at=? WHERE id=?', [data.values.due_at as number | null, ctx.now, id!]);
  }
  await clearSession(ctx.db, ctx.user.id);
  await say(ctx, 'Задание сохранено.'); await showTask(ctx, id!);
}

async function changeRole(ctx: Context, data: FormData, input: string): Promise<void> {
  if (!await isOrg(ctx)) return;
  const token = input.trim();
  let user: UserRow | null = null;
  if (/^[1-9]\d{0,15}$/.test(token) && Number.isSafeInteger(Number(token))) user = await getUser(ctx.db, Number(token));
  else if (/^@?[A-Za-z][A-Za-z0-9_]{3,31}$/.test(token)) user = await ctx.db.get<UserRow>('SELECT * FROM users WHERE lower(username)=lower(?)', [token.replace(/^@/, '')]);
  if (!user) { await say(ctx, 'Пользователь не найден. Нужен известный боту @ник или Telegram ID.'); return; }
  if (data.action === 'remove' && bootstraps(ctx.env).includes(user.id)) { await say(ctx, 'Это один из первых организаторов, заданных при запуске. Чтобы снять эту роль, сначала уберите его ID из BOOTSTRAP_ORG_IDS в настройках развёртывания.'); return; }
  if (data.action === 'remove') {
    // One conditional SQL statement also protects against concurrent removals.
    const result = await ctx.db.run("UPDATE users SET role='member',updated_at=? WHERE id=? AND role='org' AND (SELECT COUNT(*) FROM users WHERE role='org')>1", [ctx.now, user.id]);
    const changed = Number(result.meta?.changes ?? 0);
    if (!changed && user.role === 'org') { await say(ctx, 'Нельзя снять роль у последнего организатора. Сначала назначьте другого.'); return; }
  } else await ctx.db.run("UPDATE users SET role='org',updated_at=? WHERE id=?", [ctx.now, user.id]);
  await clearSession(ctx.db, ctx.user.id);
  await say(ctx, data.action === 'remove' ? `У ${user.username ? `@${user.username}` : user.display_name} снята роль организатора. Уже открытые внутренние карточки больше не дадут доступа.` : `${user.username ? `@${user.username}` : user.display_name} теперь организатор. Новое меню появится после /start.`);
  if ((await getUser(ctx.db, ctx.user.id))?.role === 'org') await roles(ctx); else await menu(ctx);
}

async function beginSuggestion(ctx: Context): Promise<void> {
  if (!await getSetting(ctx.db, 'suggestions_chat_id')) { await say(ctx, 'Орги ещё не настроили тему предложений. Попробуйте позже.'); return; }
  await saveForm(ctx, 'suggestion', 'content', newData());
}

async function queueSuggestion(ctx: Context, message: TelegramMessage): Promise<void> {
  if (!(message.text || message.caption || message.photo || message.document || message.video || message.audio || message.voice || message.sticker)) { await say(ctx, 'Отправьте текст или медиа одним сообщением.'); return; }
  const chat = Number(await getSetting(ctx.db, 'suggestions_chat_id'));
  const thread = Number(await getSetting(ctx.db, 'suggestions_thread_id')) || null;
  if (!Number.isSafeInteger(chat) || chat >= 0) { await say(ctx, 'Тема предложений временно не настроена. Сообщение ещё не отправлено — попробуйте позже.'); return; }
  const existing = await ctx.db.get<{ id: string }>('SELECT id FROM suggestions WHERE user_id=? AND chat_id=? AND message_id=?', [ctx.user.id, message.chat.id, message.message_id]);
  if (!existing) {
    const id = crypto.randomUUID();
    const body: Record<string, unknown> = { chat_id: chat, from_chat_id: message.chat.id, message_id: message.message_id, reply_markup: { inline_keyboard: [[{ text: `Автор: ${short(ctx.user.username ? `@${ctx.user.username}` : ctx.user.display_name, 45)}`, url: `tg://user?id=${ctx.user.id}` }]] } };
    if (thread) body.message_thread_id = thread;
    await ctx.db.batch([
      { sql: 'INSERT OR IGNORE INTO suggestions(id,user_id,chat_id,message_id,body_text,created_at) VALUES(?,?,?,?,?,?)', params: [id, ctx.user.id, message.chat.id, message.message_id, message.text ?? message.caption ?? null, ctx.now] },
      { sql: "INSERT OR IGNORE INTO notifications(id,dedupe_key,kind,chat_id,thread_id,scheduled_at,payload,state,attempts,next_attempt_at,created_at) VALUES(?,?,'suggestion',?,?,?,?,'pending',0,?,?)", params: [crypto.randomUUID(), `suggestion:${ctx.user.id}:${message.chat.id}:${message.message_id}`, chat, thread, ctx.now, JSON.stringify({ method: 'copyMessage', body }), ctx.now, ctx.now] }
    ]);
  }
  await clearSession(ctx.db, ctx.user.id);
  await say(ctx, 'Предложение принято в очередь для оргов. Обычно доставка занимает до минуты.', [mainButton()]);
}

async function advanceForm(ctx: Context, session: SessionRow, data: FormData, message: TelegramMessage | null, action?: string): Promise<void> {
  const { flow, step } = session;
  if (flow !== 'suggestion' && !await isOrg(ctx)) return;
  if (action === 'cancel') { await clearSession(ctx.db, ctx.user.id); await say(ctx, 'Форма отменена.'); await menu(ctx); return; }
  if (flow === 'suggestion') { if (message) await queueSuggestion(ctx, message); return; }
  if (flow === 'role') { if (message?.text) await changeRole(ctx, data, message.text); else await say(ctx, 'Отправьте @ник или Telegram ID текстом.'); return; }
  const input = message?.text?.trim();
  const v = data.values;
  if (step === 'title') {
    const max = flow.includes('task') ? 1000 : 200;
    if (!input || input.length > max) { await say(ctx, `Нужен текст от 1 до ${max} символов.`); return; }
    v.title = input;
  } else if (step === 'status') {
    if (!action || !Object.hasOwn(STATUSES, action)) { await say(ctx, 'Выберите статус кнопкой.'); return; }
    v.status = action;
  } else if (step === 'start_at' || step === 'due_at' || step === 'registration_deadline') {
    if (action === 'skip' && (step === 'due_at' || (step === 'start_at' && v.status === 'idea'))) v[step] = null;
    else {
      const parsed = input ? parseDateTime(input, timezone(ctx)) : null;
      if (parsed === null) { await say(ctx, 'Не получилось прочитать дату. Нужен формат ДД.ММ.ГГГГ ЧЧ:ММ и существующая дата, например 30.10.2026 19:00.'); return; }
      v[step] = parsed;
    }
  } else if (step === 'visibility') {
    if (action !== 'public' && action !== 'private') { await say(ctx, 'Выберите видимость кнопкой.'); return; }
    v.visibility = action;
  } else if (step === 'assignees') {
    if (action === 'skip') v.assignees = [];
    else if (action === 'self') v.assignees = [ctx.user.id];
    else {
      if (!input) { await say(ctx, 'Отправьте @ники текстом или выберите кнопку.'); return; }
      const ids = await resolveAssignees(ctx, input); if (!ids) return;
      v.assignees = ids;
    }
  } else if (step === 'location') {
    if (action === 'skip') v.location = null;
    else if (!input || input.length > 500) { await say(ctx, 'Нужна локация от 1 до 500 символов или кнопка пропуска.'); return; }
    else v.location = input;
  } else if (step === 'post_url') {
    const url = message ? postUrl(message) : null;
    if (!url) { await say(ctx, 'Нужна ссылка на конкретный пост https://t.me/канал/123 или пересланная публикация из канала. Ссылка на сам канал не подойдёт.'); return; }
    v.post_url = url;
    if (data.kind === 'event') { await saveForm(ctx, flow, 'registration_deadline', data); return; }
  } else { await clearSession(ctx.db, ctx.user.id); await say(ctx, 'Форма устарела. Начните её заново из меню.'); return; }

  if (flow === 'edit_item') { await finishItem(ctx, flow, data); return; }
  if (flow === 'edit_task') { await finishTask(ctx, flow, data); return; }
  if (flow === 'create_item') {
    const steps = data.kind === 'event' ? ['title', 'status', 'start_at', 'visibility', 'assignees', 'location'] : ['title', 'status', 'start_at', 'assignees'];
    const next = steps[steps.indexOf(step) + 1];
    if (next) await saveForm(ctx, flow, next, data); else await finishItem(ctx, flow, data);
  } else if (flow === 'create_task') {
    const steps = ['title', 'assignees', 'due_at'];
    const next = steps[steps.indexOf(step) + 1];
    if (next) await saveForm(ctx, flow, next, data); else await finishTask(ctx, flow, data);
  }
}

async function formInput(ctx: Context, message: TelegramMessage | null, action?: string, token?: string): Promise<boolean> {
  const session = await getSession(ctx.db, ctx.user.id, ctx.now);
  if (!session) { if (token) await say(ctx, 'Эта форма уже закрыта или истекла. Начните заново из меню.', [mainButton()]); return false; }
  let data: FormData;
  try { data = JSON.parse(session.data) as FormData; } catch { await clearSession(ctx.db, ctx.user.id); await say(ctx, 'Форма повреждена. Начните заново из меню.'); return true; }
  if (!data.token || !data.values) { await clearSession(ctx.db, ctx.user.id); return true; }
  if (data.lastUpdateId === ctx.updateId) {
    if (session.flow !== 'suggestion' && !await isOrg(ctx)) return true;
    await prompt(ctx, session.flow, session.step, data);
    return true;
  }
  if (token && token !== data.token) { await say(ctx, 'Это кнопка старой формы. Продолжайте последнюю форму или отправьте /cancel.'); return true; }
  await advanceForm(ctx, session, data, message, action);
  return true;
}

async function configureChat(ctx: Context, message: TelegramMessage, type: 'org' | 'suggestions'): Promise<void> {
  if (!await isOrg(ctx)) return;
  if (message.chat.type !== 'group' && message.chat.type !== 'supergroup') { await say(ctx, 'Выполните эту команду в нужной теме беседы оргов, куда добавлен бот.'); return; }
  const prefix = type === 'org' ? 'org' : 'suggestions';
  // The settings and internal-group flag change atomically: never briefly broadcast into the org chat.
  await ctx.db.batch([
    { sql: 'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', params: [`${prefix}_chat_id`, String(message.chat.id)] },
    { sql: 'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', params: [`${prefix}_thread_id`, message.message_thread_id ? String(message.message_thread_id) : ''] },
    { sql: 'INSERT INTO groups(chat_id,title,enabled,org_only,updated_at) VALUES(?,?,1,1,?) ON CONFLICT(chat_id) DO UPDATE SET title=excluded.title,enabled=1,org_only=1,updated_at=excluded.updated_at', params: [message.chat.id, message.chat.title ?? 'Чат оргов', ctx.now] }
  ]);
  await ctx.telegram.sendMessage(message.chat.id, type === 'org' ? 'Здесь будут организационные напоминания. Эта беседа исключена из публичной рассылки.' : 'Здесь будут предложения участников. Эта беседа исключена из публичной рассылки.', message.message_thread_id ? { message_thread_id: message.message_thread_id } : {});
}

async function handleCallback(ctx: Context, data: string): Promise<void> {
  const [command, a, b, c] = data.split(':');
  if (command === 'menu') { await clearSession(ctx.db, ctx.user.id); await menu(ctx); }
  else if (command === 'cal') await calendar(ctx, a === 'o', b, Number(c));
  else if (command === 'ideas') await ideas(ctx, Number(a));
  else if (command === 'item') await showItem(ctx, a);
  else if (command === 'edit') await editItemMenu(ctx, a);
  else if (command === 'ie') await beginEditItem(ctx, a, b);
  else if (command === 'publish') {
    const item = await itemForOrg(ctx, a); if (!item || item.kind !== 'event') return;
    if (b !== '0' && b !== '1') { await showItem(ctx, a); return; }
    const target = Number(b);
    if (target && (item.visibility !== 'public' || item.start_at === null)) { await say(ctx, 'Для публикации нужны публичная видимость и дата мероприятия. Задайте их через «Изменить».'); return; }
    await ctx.db.run('UPDATE items SET published=?,revision=revision+1,updated_at=? WHERE id=? AND published<>?', [target, ctx.now, a, target]);
    await say(ctx, target ? 'Мероприятие опубликовано в расписании. Если настроены пост и дедлайн регистрации, включатся публичные напоминания.' : 'Мероприятие скрыто из публичного расписания. Регистрационные напоминания выключены.'); await showItem(ctx, a);
  } else if (command === 'noalert') {
    const item = await itemForOrg(ctx, a); if (!item) return;
    await ctx.db.run('UPDATE items SET registration_deadline=NULL,revision=revision+1,updated_at=? WHERE id=?', [ctx.now, a]);
    await say(ctx, 'Напоминания о регистрации отключены.'); await showItem(ctx, a);
  } else if (command === 'sub') await subscription(ctx, a === 'on');
  else if (command === 'tasks') await showTasks(ctx, a, Number(b));
  else if (command === 'newtask') await beginTask(ctx, a);
  else if (command === 'subtask') { const parent = await taskForOrg(ctx, a); if (parent) await beginTask(ctx, parent.item_id, parent.id); }
  else if (command === 'task') await showTask(ctx, a);
  else if (command === 'te') await beginEditTask(ctx, a, b);
  else if (command === 'taskdone') {
    const task = await taskForOrg(ctx, a); if (!task) return;
    if (b !== 'open' && b !== 'done') { await showTask(ctx, a); return; }
    await ctx.db.run('UPDATE tasks SET status=?,revision=revision+1,updated_at=? WHERE id=? AND status<>?', [b, ctx.now, a, b]);
    await showTask(ctx, a);
  } else if (command === 'mine') await myTasks(ctx, Number(a));
  else if (command === 'role' && ['add', 'remove'].includes(a)) { if (await isOrg(ctx)) await saveForm(ctx, 'role', 'user', newData({ action: a })); }
  else if (command === 'f') await formInput(ctx, null, b, a);
  else await say(ctx, 'Кнопка устарела. Откройте меню.', [mainButton()]);
}

/** Worker claims update_id before calling this function. All forms and entities survive restarts. */
export async function handleUpdate(update: TelegramUpdate, env: Env, db: Database, telegram: TelegramApi, now = Date.now()): Promise<void> {
  if (update.my_chat_member) {
    const member = update.my_chat_member;
    if (member.chat.type !== 'group' && member.chat.type !== 'supergroup') return;
    const active = ['member', 'administrator'].includes(member.new_chat_member.status) ? 1 : 0;
    const internalChats = [await getSetting(db, 'org_chat_id'), await getSetting(db, 'suggestions_chat_id')];
    const internal = internalChats.includes(String(member.chat.id)) ? 1 : 0;
    await db.run('INSERT INTO groups(chat_id,title,enabled,org_only,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(chat_id) DO UPDATE SET title=excluded.title,enabled=excluded.enabled,org_only=MAX(groups.org_only,excluded.org_only),updated_at=excluded.updated_at', [member.chat.id, member.chat.title ?? 'Группа', active, internal, now]);
    return;
  }
  const callback = update.callback_query;
  const message = update.message ?? callback?.message;
  const from = callback?.from ?? message?.from;
  if (!message || !from || from.is_bot || message.chat.type === 'channel') return;
  const user = await upsertUser(db, from, bootstraps(env), now);
  if (user.role === 'org') telegram.markOrganizerContent();
  const ctx: Context = { env, db, telegram, now, updateId: update.update_id, user, chatId: message.chat.id };
  if (message.chat.type === 'private') await db.run('UPDATE users SET dm_active=1,updated_at=? WHERE id=?', [now, user.id]);
  if (callback) {
    await telegram.answerCallbackQuery(callback.id);
    if (message.chat.type !== 'private') { await say(ctx, 'Управление и личное расписание доступны в личном чате с ботом.'); return; }
    if (callback.data) await handleCallback(ctx, callback.data);
    return;
  }
  const input = message.text?.trim() ?? '';
  const command = input.split(/\s/, 1)[0]?.split('@')[0]?.toLowerCase();
  if (command === '/id') { await telegram.sendMessage(ctx.chatId, `Ваш Telegram ID: ${from.id}${message.chat.type !== 'private' ? `\nID чата: ${message.chat.id}${message.message_thread_id ? `\nID темы: ${message.message_thread_id}` : ''}` : ''}`, message.message_thread_id ? { message_thread_id: message.message_thread_id } : {}); return; }
  if (command === '/orgchat' || command === '/suggestionschat') { await configureChat(ctx, message, command === '/orgchat' ? 'org' : 'suggestions'); return; }
  if (message.chat.type !== 'private') return;
  if (['/start', '/menu', '/help', '/cancel'].includes(command)) {
    await clearSession(db, from.id);
    if (command === '/cancel') await say(ctx, 'Форма отменена.');
    await menu(ctx); return;
  }
  if (command === '/calendar' || command === '/subscribe' || command === '/unsubscribe' || command === '/suggest') {
    await clearSession(db, from.id);
    if (command === '/calendar') await calendar(ctx, false);
    else if (command === '/suggest') await beginSuggestion(ctx);
    else await subscription(ctx, command === '/subscribe');
    return;
  }
  const actions: Record<string, () => Promise<void>> = {
    [LABELS.public]: () => calendar(ctx, false), [LABELS.subscribe]: () => subscription(ctx), [LABELS.suggest]: () => beginSuggestion(ctx),
    [LABELS.internal]: () => calendar(ctx, true), [LABELS.mine]: () => myTasks(ctx), [LABELS.event]: () => beginItem(ctx, 'event'), [LABELS.post]: () => beginItem(ctx, 'post'), [LABELS.roles]: () => roles(ctx), [LABELS.menu]: () => menu(ctx)
  };
  if (Object.hasOwn(actions, input)) { await clearSession(db, from.id); await actions[input](); return; }
  if (await formInput(ctx, message)) return;
  await say(ctx, 'Выберите действие в меню. Для предложения нажмите «💡 Предложить идею».'); await menu(ctx);
}
