-- 0079: 群方言 exemplar 库 (AGI H2.1)
-- 每群 10 条"最有那味儿"的真人原话,只学风格不学内容。
-- 冷启动:learner-scan 首次补;定期轮换(90 天 TTL)防学到某人口头禅。
-- 纯增量表,删了只丢方言素材,不影响主流程。
CREATE TABLE IF NOT EXISTS dialect_exemplars (
  chat_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  picked_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (chat_id, content)
);
CREATE INDEX IF NOT EXISTS idx_dialect_chat ON dialect_exemplars(chat_id);
