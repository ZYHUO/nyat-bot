-- Host-owned, bounded QQ delegation. No private source message is copied here.
CREATE TABLE IF NOT EXISTS onebot_assignments (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  input_json TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  controller_chat_id INTEGER NOT NULL CHECK (controller_chat_id > 0),
  target_chat_id INTEGER NOT NULL CHECK (target_chat_id < 0),
  target_group_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at AND expires_at <= created_at + 1800000),
  mode TEXT NOT NULL CHECK (mode IN ('once', 'participate')),
  max_messages INTEGER NOT NULL CHECK (max_messages BETWEEN 1 AND 5),
  min_interval_ms INTEGER NOT NULL CHECK (min_interval_ms >= 30000),
  public_text TEXT,
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'stopped', 'expired', 'exhausted', 'held')),
  reserved_messages INTEGER NOT NULL DEFAULT 0 CHECK (reserved_messages BETWEEN 0 AND max_messages),
  acknowledged_messages INTEGER NOT NULL DEFAULT 0 CHECK (acknowledged_messages BETWEEN 0 AND reserved_messages),
  last_send_at INTEGER,
  CHECK (mode <> 'once' OR max_messages = 1),
  UNIQUE (account_id, command_id)
);
CREATE INDEX IF NOT EXISTS onebot_assignments_target ON onebot_assignments (target_chat_id, state, expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS onebot_assignments_active_participation
  ON onebot_assignments (account_id, target_chat_id) WHERE mode = 'participate' AND state = 'active';

CREATE TABLE IF NOT EXISTS onebot_assignment_tasks (
  task_id TEXT PRIMARY KEY,
  assignment_id TEXT NOT NULL REFERENCES onebot_assignments(id),
  chat_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS onebot_assignment_sends (
  id TEXT PRIMARY KEY,
  assignment_id TEXT NOT NULL REFERENCES onebot_assignments(id),
  task_id TEXT NOT NULL UNIQUE REFERENCES onebot_assignment_tasks(task_id),
  chat_id INTEGER NOT NULL,
  bubble_count INTEGER NOT NULL CHECK (bubble_count BETWEEN 1 AND 5),
  created_at INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved', 'acknowledged', 'failed', 'unknown'))
);
CREATE INDEX IF NOT EXISTS onebot_assignment_sends_grant ON onebot_assignment_sends (assignment_id, state);

CREATE TABLE IF NOT EXISTS onebot_assignment_receipts (
  reservation_id TEXT NOT NULL REFERENCES onebot_assignment_sends(id),
  assignment_id TEXT NOT NULL REFERENCES onebot_assignments(id),
  bubble_index INTEGER NOT NULL CHECK (bubble_index >= 0 AND bubble_index < 5),
  message_id TEXT NOT NULL,
  acknowledged_at INTEGER NOT NULL,
  PRIMARY KEY (reservation_id, bubble_index),
  UNIQUE (assignment_id, message_id)
);

CREATE TABLE IF NOT EXISTS onebot_assignment_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assignment_id TEXT NOT NULL REFERENCES onebot_assignments(id),
  event_type TEXT NOT NULL,
  details_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
