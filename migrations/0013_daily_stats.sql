CREATE TABLE IF NOT EXISTS daily_stats (
  chat_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  total_messages INTEGER DEFAULT 0,
  active_users INTEGER DEFAULT 0,
  bot_replies INTEGER DEFAULT 0,
  top_users TEXT DEFAULT '[]',
  PRIMARY KEY(chat_id, date)
);
