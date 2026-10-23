import { pathToFileURL } from 'node:url';
import { ask, readLocalVars, telegramCall } from './lib.mjs';

export async function configureWebhook(workerUrl, values = undefined) {
  const secrets = values ?? await readLocalVars();
  if (!secrets.TELEGRAM_BOT_TOKEN || !secrets.WEBHOOK_SECRET) throw new Error('Сначала выполните pnpm setup.');
  const origin = new URL(workerUrl);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash || !['', '/'].includes(origin.pathname)) {
    throw new Error('Укажите HTTPS-адрес Worker без пути, логина и параметров.');
  }
  const health = await fetch(new URL('/health', origin), { signal: AbortSignal.timeout(15_000) }).catch(() => null);
  if (!health?.ok) throw new Error('Worker не отвечает на /health. Сначала проверьте развёртывание.');
  await telegramCall(secrets.TELEGRAM_BOT_TOKEN, 'setWebhook', {
    url: new URL('/webhook', origin).href,
    secret_token: secrets.WEBHOOK_SECRET,
    allowed_updates: ['message', 'callback_query', 'my_chat_member'],
    max_connections: 5,
    drop_pending_updates: false,
  });
  await telegramCall(secrets.TELEGRAM_BOT_TOKEN, 'setMyCommands', { commands: [
    { command: 'start', description: 'Главное меню' },
    { command: 'calendar', description: 'Расписание мероприятий' },
    { command: 'subscribe', description: 'Подписаться на все события' },
    { command: 'unsubscribe', description: 'Отключить напоминания' },
    { command: 'suggest', description: 'Предложить идею организаторам' },
    { command: 'id', description: 'Мой Telegram ID' },
    { command: 'cancel', description: 'Отменить заполнение формы' },
  ] });
  const status = await telegramCall(secrets.TELEGRAM_BOT_TOKEN, 'getWebhookInfo');
  if (status.url !== new URL('/webhook', origin).href) throw new Error('Telegram не подтвердил нужный webhook.');
  console.log('Webhook подключён. Откройте бота и отправьте /start.');
  console.log('В теме напоминаний чата оргов: /orgchat. В теме предложений: /suggestionschat.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  (async () => configureWebhook(process.argv[2] ?? await ask('HTTPS-адрес Worker: ')))()
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
