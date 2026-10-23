import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TelegramApi, TelegramApiError } from '../src/telegram.js';

test('sends JSON to Telegram and returns its result', async () => {
  const api = new TelegramApi('test-token', (async (url, init) => {
    assert.equal(url, 'https://api.telegram.org/bottest-token/sendMessage');
    assert.deepEqual(JSON.parse(String(init?.body)), { chat_id: 123, text: 'Привет' });
    return Response.json({ ok: true, result: { message_id: 9 } });
  }) as typeof fetch);
  assert.equal((await api.sendMessage(123, 'Привет')).message_id, 9);
});

test('preserves retry_after so the durable queue can retry at the right time', async () => {
  const api = new TelegramApi('secret', (async () => Response.json({
    ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 37 },
  }, { status: 429 })) as typeof fetch);
  await assert.rejects(api.sendMessage(1, 'test'), (error: unknown) => {
    assert.ok(error instanceof TelegramApiError);
    assert.equal(error.errorCode, 429);
    assert.equal(error.retryAfter, 37);
    return true;
  });
});

test('network failures and API error text do not expose the token', async () => {
  for (const fetcher of [
    (async () => { throw new Error('https://api.telegram.org/botvery-secret/sendMessage'); }) as typeof fetch,
    (async () => Response.json({ ok: false, error_code: 400, description: 'very-secret' })) as typeof fetch,
  ]) {
    const api = new TelegramApi('very-secret', fetcher);
    await assert.rejects(api.sendMessage(1, 'test'), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes('very-secret'), false);
      return true;
    });
  }
});

test('copies media messages into the selected forum topic', async () => {
  const api = new TelegramApi('token', (async (_url, init) => {
    assert.deepEqual(JSON.parse(String(init?.body)), { message_thread_id: 42, chat_id: -100, from_chat_id: 123, message_id: 7 });
    return Response.json({ ok: true, result: { message_id: 8 } });
  }) as typeof fetch);
  assert.equal((await api.copyMessage(-100, 123, 7, { message_thread_id: 42 })).message_id, 8);
});
