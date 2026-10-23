import { randomBytes } from 'node:crypto';
import { ask, readLocalVars, writeLocalVars, telegramCall } from './lib.mjs';

async function main() {
  console.log('Локальная настройка бота. Секреты останутся в игнорируемом .dev.vars с правами 0600.');
  const values = await readLocalVars();
  const token = values.TELEGRAM_BOT_TOKEN && !values.TELEGRAM_BOT_TOKEN.startsWith('replace-')
    ? values.TELEGRAM_BOT_TOKEN : await ask('Токен нового бота из @BotFather (ввод скрыт): ', { hidden: true });
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) throw new Error('Не похоже на токен Telegram-бота.');
  const me = await telegramCall(token, 'getMe');
  values.TELEGRAM_BOT_TOKEN = token;
  if (!values.WEBHOOK_SECRET || values.WEBHOOK_SECRET.startsWith('replace-')) values.WEBHOOK_SECRET = randomBytes(32).toString('hex');
  values.BOT_USERNAME = me.username;
  await writeLocalVars(values);
  console.log(`Бот: @${me.username}. Токен проверен и сохранён без вывода на экран.`);

  if (!values.BOOTSTRAP_ORG_IDS || !/^\d+(\s*,\s*\d+)*$/.test(values.BOOTSTRAP_ORG_IDS)) {
    let ids = await ask('Telegram ID первых оргов через запятую (Enter — определить по /start): ');
    if (!ids) {
      console.log(`Откройте https://t.me/${me.username} и отправьте /start.`);
      await ask('После отправки нажмите Enter: ');
      const updates = await telegramCall(token, 'getUpdates', { timeout: 0, allowed_updates: ['message'] });
      const messages = updates.filter(update => update.message?.chat?.type === 'private' && update.message.from && !update.message.from.is_bot);
      const last = messages.at(-1)?.message;
      if (!last) throw new Error('Личное сообщение пока не найдено. Отправьте /start и повторите pnpm setup.');
      const selected = await ask(`Сделать первым оргом ${last.from.first_name} (ID ${last.from.id})? [Y/n]: `);
      if (!['', 'y', 'yes', 'д', 'да'].includes(selected.toLowerCase())) throw new Error('Укажите нужные ID при повторном запуске.');
      ids = String(last.from.id);
    }
    if (!/^\d+(\s*,\s*\d+)*$/.test(ids) || ids.split(',').some(id => !Number.isSafeInteger(Number(id)) || Number(id) <= 0)) {
      throw new Error('ID должны быть положительными целыми числами через запятую.');
    }
    values.BOOTSTRAP_ORG_IDS = ids.split(',').map(id => id.trim()).join(',');
  }
  await writeLocalVars(values);
  console.log('Готово. Для проверки: pnpm db:migrate:local, затем pnpm dev.');
  console.log('Для развёртывания на Cloudflare: pnpm cloudflare:setup.');
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
