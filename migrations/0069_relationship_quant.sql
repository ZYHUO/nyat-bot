-- ============================================
-- #2 关系评分量化 (CGM memory-v2 reflection 移植)
-- chat_relationships 侧车列:量化评分/ tier / 待消费 quality 增量。
-- 不动 affinity 列 —— 现有 LLM 事件流与 prompt bucket 注入语义完全不变。
-- relationship_activity_daily: per-(chat,uid,day) 消息计数,
-- 给 30 天滚动窗口提供互动次数 / 活跃天数两个维度。
-- ============================================

ALTER TABLE chat_relationships ADD COLUMN quant_score REAL NOT NULL DEFAULT 0;
ALTER TABLE chat_relationships ADD COLUMN quant_tier INTEGER NOT NULL DEFAULT 4;
-- 两次重算之间累积的 interaction-quality 增量(clamp [-20, 15]),
-- recompute 时一次性消费并清零。
ALTER TABLE chat_relationships ADD COLUMN quant_quality_pending REAL NOT NULL DEFAULT 0;
ALTER TABLE chat_relationships ADD COLUMN quant_updated_at INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS relationship_activity_daily (
  chat_id INTEGER NOT NULL,
  uid INTEGER NOT NULL,
  -- YYYY-MM-DD (UTC, 与 daily_stats 一致)
  date TEXT NOT NULL,
  msg_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (chat_id, uid, date)
);

CREATE INDEX IF NOT EXISTS idx_rel_activity_chat_date
  ON relationship_activity_daily(chat_id, date);
