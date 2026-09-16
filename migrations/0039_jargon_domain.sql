-- B 黑话 domain 分桶:给黑话打领域标签(infra/梗/general),供按域选择性注入。
-- 默认 general,旧数据无损;加索引便于按域查询。
ALTER TABLE jargons ADD COLUMN domain TEXT NOT NULL DEFAULT 'general';
CREATE INDEX IF NOT EXISTS idx_jargons_chat_domain ON jargons(chat_id, domain, count DESC);
