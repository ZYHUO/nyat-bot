-- G7(语言生命层):群共同经历记忆 — "上周群里那件事"
-- per-user 记忆已深(profile sections/relationship/roles),但群级 episodic
-- 记忆不存在 → bot 无法 callback 群的共同经历。小时级 cron 摘要写入,
-- 回复时按关键词命中注入 ≤2 条。

CREATE TABLE IF NOT EXISTS group_episodes (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id          INTEGER NOT NULL,
  summary          TEXT    NOT NULL,
  -- 摘要里的关键词(空格分隔,命中注入用)
  keywords         TEXT    NOT NULL DEFAULT '',
  salience         REAL    NOT NULL DEFAULT 0.5,
  source_msg_id    INTEGER,
  created_at       INTEGER NOT NULL,
  last_recalled_at INTEGER NOT NULL DEFAULT 0,
  recall_count     INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_group_episodes_chat
  ON group_episodes(chat_id, created_at DESC);
