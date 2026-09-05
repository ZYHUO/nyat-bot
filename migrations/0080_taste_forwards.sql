-- 0080: taste 转发表 (AGI H3.1)
-- bot 转发过哪条消息(跨群去重 7 天),纯增量表,删了只丢去重记忆。
CREATE TABLE IF NOT EXISTS taste_forwards (
  from_chat_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  score REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (from_chat_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_taste_fwd_time ON taste_forwards(created_at);
