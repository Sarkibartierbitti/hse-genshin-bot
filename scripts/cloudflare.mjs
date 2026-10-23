import { readFile, writeFile } from 'node:fs/promises';
import { readLocalVars, runWrangler, ask } from './lib.mjs';

async function main() {
  const secrets = await readLocalVars();
  for (const key of ['TELEGRAM_BOT_TOKEN', 'WEBHOOK_SECRET', 'BOOTSTRAP_ORG_IDS']) {
    if (!secrets[key] || secrets[key].startsWith('replace-')) throw new Error('Сначала выполните pnpm setup.');
  }
  const account = await runWrangler(['whoami'], { quiet: true, allowFailure: true });
  if (account.code !== 0 || /not authenticated|not logged in/i.test(account.output)) {
    console.log('Войдите в бесплатный аккаунт Cloudflare в открывающемся браузере.');
    await runWrangler(['login']);
  }
  const configPath = new URL('../wrangler.jsonc', import.meta.url);
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const binding = config.d1_databases.find(db => db.binding === 'DB');
  if (!binding) throw new Error('В wrangler.jsonc отсутствует привязка DB.');
  if (binding.database_id === '00000000-0000-0000-0000-000000000000') {
    const created = await runWrangler(['d1', 'create', binding.database_name]);
    const id = /database_id["']?\s*[:=]\s*["']([a-f\d-]{36})["']/i.exec(created.output)?.[1];
    if (!id) throw new Error('База создана, но ID не удалось распознать. Внесите database_id из вывода в wrangler.jsonc и повторите команду; новую базу создавать не нужно.');
    binding.database_id = id;
    await writeFile(configPath, JSON.stringify(config, null, 2) + '\n');
  }
  const queueName = config.queues.producers.find(queue => queue.binding === 'DELIVERY_QUEUE')?.queue;
  if (!queueName) throw new Error('В wrangler.jsonc отсутствует очередь DELIVERY_QUEUE.');
  const queue = await runWrangler(['queues', 'info', queueName], { quiet: true, allowFailure: true });
  if (queue.code !== 0) await runWrangler(['queues', 'create', queueName]);
  await runWrangler(['d1', 'migrations', 'apply', 'DB', '--remote']);
  const deployed = await runWrangler(['deploy']);
  // The complete secret JSON goes through stdin, never process arguments or shell interpolation.
  await runWrangler(['secret', 'bulk'], { input: JSON.stringify(secrets), quiet: true });
  console.log('Секреты загружены в Cloudflare.');
  const url = /https:\/\/[a-z0-9.-]+\.workers\.dev\b/i.exec(deployed.output)?.[0];
  console.log(`Worker развёрнут${url ? `: ${url}` : ''}.`);
  const answer = await ask('Подключить Telegram webhook к этому Worker? [Y/n]: ');
  if (!['', 'y', 'yes', 'д', 'да'].includes(answer.toLowerCase())) return;
  const workerUrl = url ?? await ask('HTTPS-адрес Worker: ');
  const { configureWebhook } = await import('./webhook.mjs');
  await configureWebhook(workerUrl, secrets);
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
