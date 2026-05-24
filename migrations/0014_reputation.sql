CREATE TABLE IF NOT EXISTS user_reputation (
  chat_id INTEGER NOT NULL,
  uid INTEGER NOT NULL,
  points INTEGER DEFAULT 0,
  level TEXT DEFAULT 'bronze',
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY(chat_id, uid)
);
CREATE TABLE IF NOT EXISTS reputation_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  uid INTEGER NOT NULL,
  delta INTEGER NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
