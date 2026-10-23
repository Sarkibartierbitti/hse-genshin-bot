import { readFile, writeFile, rename, chmod } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const localVarsPath = new URL('../.dev.vars', import.meta.url);

export async function ask(prompt, { hidden = false } = {}) {
  if (hidden) process.stdout.write(prompt);
  const output = hidden ? new Writable({ write(_chunk, _encoding, callback) { callback(); } }) : process.stdout;
  const reader = createInterface({ input: process.stdin, output, terminal: Boolean(process.stdin.isTTY) });
  try {
    return (await reader.question(hidden ? '' : prompt)).trim();
  } finally {
    reader.close();
    if (hidden) process.stdout.write('\n');
  }
}

export function parseLocalVars(text) {
  const result = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Z_]+)\s*=\s*(.*)$/.exec(line.trim());
    if (!match) continue;
    const value = match[2].trim();
    if (value.startsWith('"')) result[match[1]] = JSON.parse(value);
    else if (value.startsWith("'") && value.endsWith("'")) result[match[1]] = value.slice(1, -1);
    else result[match[1]] = value;
  }
  return result;
}

export async function readLocalVars() {
  try { return parseLocalVars(await readFile(localVarsPath, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}

export async function writeLocalVars(values) {
  const temporary = new URL('../.dev.vars.tmp', import.meta.url);
  const text = Object.entries(values).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n') + '\n';
  await writeFile(temporary, text, { mode: 0o600 });
  await rename(temporary, localVarsPath);
  await chmod(localVarsPath, 0o600);
}

export async function telegramCall(token, method, body = {}) {
  let data;
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
    });
    data = await response.json();
  } catch {
    throw new Error('Не удалось связаться с Telegram. Проверьте сеть и повторите команду.');
  }
  if (!data.ok) throw new Error(`Telegram отклонил ${method} (код ${data.error_code ?? 'неизвестен'}).`);
  return data.result;
}

export async function runWrangler(args, { input, quiet = false, allowFailure = false } = {}) {
  const binary = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));
  const child = spawn(process.execPath, [binary, ...args], {
    cwd: root, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk.toString(); if (!quiet) process.stdout.write(chunk); });
  child.stderr.on('data', chunk => { output += chunk.toString(); if (!quiet) process.stderr.write(chunk); });
  child.stdin.on('error', () => {});
  child.stdin.end(input);
  const code = await new Promise((resolve, reject) => {
    child.on('error', () => reject(new Error('Не удалось запустить Wrangler. Выполните pnpm install.')));
    child.on('close', resolve);
  });
  if (code !== 0 && !allowFailure) throw new Error(`Wrangler ${args.slice(0, 2).join(' ')} завершился с ошибкой.`);
  return { code, output };
}
