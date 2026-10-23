-- SQLite cannot extend an existing CHECK constraint. Preserve all jobs and delivery state
-- while allowing reliable UI replies in the same outbox as scheduled notifications.
CREATE TABLE notifications_new (
  id TEXT PRIMARY KEY NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('event', 'post', 'task', 'registration', 'suggestion', 'reply')),
  item_id TEXT REFERENCES items (id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks (id) ON DELETE CASCADE,
  item_revision INTEGER,
  task_revision INTEGER,
  recipient_user_id INTEGER REFERENCES users (id) ON DELETE CASCADE,
  chat_id INTEGER NOT NULL,
  thread_id INTEGER,
  scheduled_at INTEGER NOT NULL,
  expires_at INTEGER,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'sending', 'sent', 'failed', 'cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at INTEGER NOT NULL,
  locked_until INTEGER,
  sent_at INTEGER,
  telegram_message_id INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL
);

INSERT INTO notifications_new (
  id, dedupe_key, kind, item_id, task_id, item_revision, task_revision,
  recipient_user_id, chat_id, thread_id, scheduled_at, expires_at, payload,
  state, attempts, next_attempt_at, locked_until, sent_at,
  telegram_message_id, last_error, created_at
)
SELECT
  id, dedupe_key, kind, item_id, task_id, item_revision, task_revision,
  recipient_user_id, chat_id, thread_id, scheduled_at, expires_at, payload,
  state, attempts, next_attempt_at, locked_until, sent_at,
  telegram_message_id, last_error, created_at
FROM notifications;

DROP TABLE notifications;
ALTER TABLE notifications_new RENAME TO notifications;

CREATE INDEX notifications_pending ON notifications (next_attempt_at, scheduled_at) WHERE state = 'pending';
CREATE INDEX notifications_lease ON notifications (locked_until) WHERE state = 'sending';
CREATE INDEX notifications_item ON notifications (item_id, state);
CREATE INDEX notifications_task ON notifications (task_id, state);
CREATE INDEX notifications_recipient ON notifications (recipient_user_id, state);
CREATE INDEX notifications_expiry ON notifications (expires_at, item_id, item_revision);
