-- 给 sticker_items 加 user_score 列
ALTER TABLE sticker_items ADD COLUMN user_score REAL DEFAULT 1.0;

-- Bot 发出的 sticker 追踪表
CREATE TABLE IF NOT EXISTS sticker_sent_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  file_unique_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  intent TEXT,
  sent_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sticker_sent_chat_msg
  ON sticker_sent_log(chat_id, message_id);

-- Sticker 用户评价表
CREATE TABLE IF NOT EXISTS sticker_ratings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_unique_id TEXT NOT NULL,
  chat_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  rating INTEGER NOT NULL DEFAULT -1,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sticker_ratings_fuid
  ON sticker_ratings(file_unique_id);
