import type { TelegramMessage } from './types.js';

export class TelegramApiError extends Error {
  readonly errorCode: number;
  readonly description: string;
  readonly retryAfter?: number;

  constructor(errorCode: number, description: string, retryAfter?: number) {
    super(`Telegram API error ${errorCode}: ${description}`);
    this.name = 'TelegramApiError';
    this.errorCode = errorCode;
    this.description = description;
    this.retryAfter = retryAfter;
  }
}

interface TelegramResponse<T> {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
}

export class TelegramApi {
  constructor(private readonly token: string, private readonly fetcher: typeof fetch = fetch) {}

  markOrganizerContent(): void { /* Buffered clients retain this access requirement. */ }

  async call<T = TelegramMessage>(method: string, body: Record<string, unknown>): Promise<T> {
    if (!/^[a-zA-Z]+$/.test(method)) throw new Error('Invalid Telegram method');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    try {
      let response: Response;
      try {
        // Workers' native fetch rejects a class instance as its receiver ("Illegal invocation").
        response = await this.fetcher.call(globalThis, `https://api.telegram.org/bot${this.token}/${method}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch {
        // Fetch errors can contain the URL, which includes the bot token.
        throw new TelegramApiError(503, 'Telegram connection unavailable');
      }
      let data: TelegramResponse<T>;
      try {
        data = await response.json() as TelegramResponse<T>;
      } catch {
        throw new TelegramApiError(response.status >= 400 ? response.status : 502, 'Invalid Telegram response');
      }
      if (!response.ok || !data.ok) {
        const description = (data.description ?? 'Request failed').split(this.token).join('[redacted]').slice(0, 300);
        throw new TelegramApiError(data.error_code ?? response.status, description, data.parameters?.retry_after);
      }
      return data.result as T;
    } finally {
      clearTimeout(timer);
    }
  }

  sendMessage(chatId: number, text: string, extra: Record<string, unknown> = {}): Promise<TelegramMessage> {
    return this.call('sendMessage', { ...extra, chat_id: chatId, text });
  }

  answerCallbackQuery(id: string, text?: string): Promise<boolean> {
    return this.call('answerCallbackQuery', { callback_query_id: id, ...(text ? { text } : {}) });
  }

  copyMessage(chatId: number, fromChatId: number, messageId: number, extra: Record<string, unknown> = {}): Promise<{ message_id: number }> {
    return this.call('copyMessage', { ...extra, chat_id: chatId, from_chat_id: fromChatId, message_id: messageId });
  }
}
