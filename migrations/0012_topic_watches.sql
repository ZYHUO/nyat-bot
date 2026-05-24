CREATE TABLE IF NOT EXISTS topic_watches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  uid INTEGER NOT NULL,
  keywords TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at INTEGER,
  UNIQUE(chat_id, uid, keywords)
);

CREATE INDEX IF NOT EXISTS idx_tw_chat ON topic_watches(chat_id);