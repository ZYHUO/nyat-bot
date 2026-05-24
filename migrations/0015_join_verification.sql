-- 群组验证设置
CREATE TABLE IF NOT EXISTS group_verify_settings (
  chat_id INTEGER PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,
  timeout_seconds INTEGER NOT NULL DEFAULT 300,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  kick_on_fail INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

-- 验证记录
CREATE TABLE IF NOT EXISTS verify_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  username TEXT,
  first_name TEXT,
  challenge_type TEXT NOT NULL,
  challenge_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  completed_at INTEGER,
  dm_message_id INTEGER,
  UNIQUE(chat_id, user_id, started_at)
);

CREATE INDEX IF NOT EXISTS idx_verify_pending ON verify_records(chat_id, user_id, status);
CREATE INDEX IF NOT EXISTS idx_verify_user ON verify_records(user_id, status);
