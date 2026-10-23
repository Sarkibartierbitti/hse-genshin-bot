export type DBValue = string | number | null;
export interface Env {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
  BOOTSTRAP_ORG_IDS?: string;
  TIMEZONE?: string;
  BOT_USERNAME?: string;
  BROADCAST_BATCH_SIZE?: string;
  DELIVERY_QUEUE?: Queue<{ notificationId: string }>;
}
export type UserRole = 'member' | 'org';
export interface UserRow {
  id: number; username: string | null; display_name: string; role: UserRole;
  subscribed: number; dm_active: number; created_at: number; updated_at: number;
}
export type ItemStatus = 'idea' | 'development' | 'ready' | 'done' | 'cancelled';
export interface ItemRow {
  id: string; kind: 'event' | 'post'; title: string; start_at: number | null;
  visibility: 'public' | 'private'; status: ItemStatus; location: string | null;
  post_url: string | null; registration_deadline: number | null; published: number;
  created_by: number; revision: number; created_at: number; updated_at: number;
}
export interface TaskRow {
  id: string; item_id: string; parent_id: string | null; title: string;
  due_at: number | null; status: 'open' | 'done'; created_by: number;
  revision: number; created_at: number; updated_at: number;
}
export interface SessionRow {
  user_id: number; flow: string; step: string; data: string;
  expires_at: number; updated_at: number;
}
export interface GroupRow {
  chat_id: number; title: string; enabled: number; org_only: number; updated_at: number;
}
export interface NotificationPayload {
  method: 'sendMessage' | 'copyMessage'; body: Record<string, unknown>;
  actor_user_id?: number;
  required_role?: 'org';
}
export interface NotificationRow {
  id: string; dedupe_key: string; kind: 'event' | 'post' | 'task' | 'registration' | 'suggestion' | 'reply';
  item_id: string | null; task_id: string | null; item_revision: number | null;
  task_revision: number | null; recipient_user_id: number | null;
  chat_id: number; thread_id: number | null; scheduled_at: number; expires_at: number | null;
  payload: string; state: 'pending' | 'sending' | 'sent' | 'failed' | 'cancelled';
  attempts: number; next_attempt_at: number; locked_until: number | null;
  sent_at: number | null; telegram_message_id: number | null;
  last_error: string | null; created_at: number;
}
export interface TelegramUser {
  id: number; is_bot?: boolean; first_name: string; last_name?: string; username?: string;
}
export interface TelegramChat {
  id: number; type: 'private' | 'group' | 'supergroup' | 'channel'; title?: string; username?: string;
}
export interface TelegramMessage {
  message_id: number; date?: number; from?: TelegramUser; chat: TelegramChat;
  text?: string; caption?: string; message_thread_id?: number;
  forward_origin?: { type: string; chat?: TelegramChat; message_id?: number };
  reply_to_message?: TelegramMessage;
  photo?: unknown[]; document?: unknown; video?: unknown; audio?: unknown;
  voice?: unknown; sticker?: unknown;
  new_chat_members?: TelegramUser[]; left_chat_member?: TelegramUser;
}
export interface TelegramUpdate {
  update_id: number; message?: TelegramMessage;
  callback_query?: { id: string; from: TelegramUser; data?: string; message?: TelegramMessage };
  my_chat_member?: {
    chat: TelegramChat; from: TelegramUser;
    new_chat_member: { status: string; user: TelegramUser };
  };
}
