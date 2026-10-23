import type { Database } from './db.js';
import { TelegramApi } from './telegram.js';
import type { DBValue, NotificationPayload, TelegramMessage } from './types.js';

/** Persist business changes before attempting outgoing Telegram messages. */
export class BufferedTelegramApi extends TelegramApi {
  readonly messages: NotificationPayload[] = [];
  private organizerContent = false;

  override markOrganizerContent(): void { this.organizerContent = true; }

  override async sendMessage(chatId: number, text: string, extra: Record<string, unknown> = {}): Promise<TelegramMessage> {
    this.messages.push({ method: 'sendMessage', body: { ...extra, chat_id: chatId, text },
      ...(this.organizerContent ? { required_role: 'org' as const } : {}) });
    return { message_id: 0, chat: { id: chatId, type: chatId > 0 ? 'private' : 'supergroup' } };
  }

  override async copyMessage(chatId: number, fromChatId: number, messageId: number, extra: Record<string, unknown> = {}): Promise<{ message_id: number }> {
    this.messages.push({ method: 'copyMessage', body: { ...extra, chat_id: chatId, from_chat_id: fromChatId, message_id: messageId },
      ...(this.organizerContent ? { required_role: 'org' as const } : {}) });
    return { message_id: 0 };
  }

  override async answerCallbackQuery(id: string, text?: string): Promise<boolean> {
    // Acknowledge the button promptly. An expired acknowledgement must not replay a mutation.
    return super.answerCallbackQuery(id, text).catch(() => false);
  }
}

export async function commitReplies(
  db: Database, updateId: number, leaseUntil: number, actorId: number | null,
  messages: NotificationPayload[], now: number,
): Promise<string[]> {
  const ids: string[] = [];
  const statements: { sql: string; params: DBValue[] }[] = [];
  for (const [index, message] of messages.entries()) {
    const id = crypto.randomUUID();
    ids.push(id);
    const chatId = Number(message.body.chat_id);
    const threadId = typeof message.body.message_thread_id === 'number' ? message.body.message_thread_id : null;
    // Sensitivity is captured while rendering; never infer it from a later role snapshot.
    const payload: NotificationPayload = { ...message, ...(actorId ? { actor_user_id: actorId } : {}) };
    // Every insertion and completion shares the same lease fence in one atomic D1 batch.
    statements.push({ sql: `INSERT OR IGNORE INTO notifications
      (id,dedupe_key,kind,recipient_user_id,chat_id,thread_id,scheduled_at,expires_at,payload,state,next_attempt_at,created_at)
      SELECT ?,?,'reply',?,?,?,?,?,?,'pending',?,?
      WHERE EXISTS (SELECT 1 FROM telegram_updates WHERE update_id=? AND state='processing' AND lease_until=?)`,
      params: [id, `reply:${updateId}:${index}`, chatId > 0 ? chatId : null, chatId, threadId,
        now + index, now + 10 * 60_000, JSON.stringify(payload), now, now, updateId, leaseUntil] });
  }
  statements.push({ sql: "UPDATE telegram_updates SET state='done',lease_until=? WHERE update_id=? AND state='processing' AND lease_until=?",
    params: [now, updateId, leaseUntil] });
  const result = await db.batch(statements);
  if (!result.at(-1)?.meta.changes) throw new Error('Update lease lost before completion');
  return ids;
}
