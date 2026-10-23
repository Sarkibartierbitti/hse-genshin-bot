PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  username TEXT,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'org')),
  subscribed INTEGER NOT NULL DEFAULT 0 CHECK (subscribed IN (0, 1)),
  dm_active INTEGER NOT NULL DEFAULT 0 CHECK (dm_active IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX users_username ON users (username COLLATE NOCASE);
CREATE INDEX users_subscribers ON users (id) WHERE subscribed = 1 AND dm_active = 1;

CREATE TABLE items (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('event', 'post')),
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  start_at INTEGER,
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('public', 'private')),
  status TEXT NOT NULL DEFAULT 'idea' CHECK (status IN ('idea', 'development', 'ready', 'done', 'cancelled')),
  location TEXT,
  post_url TEXT,
  registration_deadline INTEGER,
  published INTEGER NOT NULL DEFAULT 0 CHECK (published IN (0, 1)),
  created_by INTEGER NOT NULL REFERENCES users (id),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX items_active_start ON items (start_at, kind) WHERE status NOT IN ('done', 'cancelled');
CREATE INDEX items_public_calendar ON items (start_at) WHERE kind = 'event' AND visibility = 'public' AND published = 1;
CREATE INDEX items_registration ON items (registration_deadline) WHERE status NOT IN ('done', 'cancelled');

CREATE TABLE item_assignees (
  item_id TEXT NOT NULL REFERENCES items (id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  PRIMARY KEY (item_id, user_id)
);
CREATE INDEX item_assignees_user ON item_assignees (user_id, item_id);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY NOT NULL,
  item_id TEXT NOT NULL REFERENCES items (id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES tasks (id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  due_at INTEGER,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
  created_by INTEGER NOT NULL REFERENCES users (id),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (parent_id IS NULL OR parent_id <> id)
);
CREATE INDEX tasks_open_deadline ON tasks (due_at, item_id) WHERE status = 'open';
CREATE INDEX tasks_item ON tasks (item_id, parent_id);
CREATE INDEX tasks_parent ON tasks (parent_id) WHERE parent_id IS NOT NULL;

-- A child must belong to the same card, and a child cannot itself have children.
CREATE TRIGGER tasks_parent_insert BEFORE INSERT ON tasks WHEN NEW.parent_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'Task parent must be a top-level task in the same item')
  WHERE NOT EXISTS (
    SELECT 1 FROM tasks p WHERE p.id = NEW.parent_id AND p.parent_id IS NULL AND p.item_id = NEW.item_id
  );
END;
CREATE TRIGGER tasks_parent_update BEFORE UPDATE OF parent_id, item_id ON tasks
BEGIN
  SELECT RAISE(ABORT, 'Task parent must be a top-level task in the same item')
  WHERE NEW.parent_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM tasks p WHERE p.id = NEW.parent_id AND p.parent_id IS NULL AND p.item_id = NEW.item_id
  );
  SELECT RAISE(ABORT, 'A task with children must remain top-level in the same item')
  WHERE EXISTS (SELECT 1 FROM tasks c WHERE c.parent_id = OLD.id)
    AND (NEW.parent_id IS NOT NULL OR NEW.item_id <> OLD.item_id);
END;

CREATE TABLE task_assignees (
  task_id TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, user_id)
);
CREATE INDEX task_assignees_user ON task_assignees (user_id, task_id);

CREATE TABLE sessions (
  user_id INTEGER PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  flow TEXT NOT NULL,
  step TEXT NOT NULL,
  data TEXT NOT NULL CHECK (json_valid(data)),
  expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX sessions_expiry ON sessions (expires_at);

CREATE TABLE groups (
  chat_id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  org_only INTEGER NOT NULL DEFAULT 0 CHECK (org_only IN (0, 1)),
  updated_at INTEGER NOT NULL
);
CREATE INDEX groups_broadcast ON groups (chat_id) WHERE enabled = 1 AND org_only = 0;

CREATE TABLE settings (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);

CREATE TABLE suggestions (
  id TEXT PRIMARY KEY NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users (id),
  chat_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  body_text TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX suggestions_user ON suggestions (user_id, created_at);

CREATE TABLE notifications (
  id TEXT PRIMARY KEY NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('event', 'post', 'task', 'registration', 'suggestion')),
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
CREATE INDEX notifications_pending ON notifications (next_attempt_at, scheduled_at) WHERE state = 'pending';
CREATE INDEX notifications_lease ON notifications (locked_until) WHERE state = 'sending';
CREATE INDEX notifications_item ON notifications (item_id, state);
CREATE INDEX notifications_task ON notifications (task_id, state);
CREATE INDEX notifications_recipient ON notifications (recipient_user_id, state);

CREATE TABLE telegram_updates (
  update_id INTEGER PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('processing', 'done')),
  lease_until INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 1 CHECK (attempts > 0),
  received_at INTEGER NOT NULL
);
CREATE INDEX telegram_updates_lease ON telegram_updates (lease_until) WHERE state = 'processing';
