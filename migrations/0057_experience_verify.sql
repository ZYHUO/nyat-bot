-- 0057: 经验验证器 + 路径质量统计 (AGI Level 5 Phase 1)
-- ① 经验验证器: 注入后任务成功/失败打分 → verified 状态
-- D 路径质量统计: 任务执行路径质量(无效调用/重试) → path_quality

-- experience_entries 验证字段
ALTER TABLE experience_entries ADD COLUMN verified INTEGER NOT NULL DEFAULT 0;
ALTER TABLE experience_entries ADD COLUMN success_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE experience_entries ADD COLUMN failure_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE experience_entries ADD COLUMN last_verified_at INTEGER;
ALTER TABLE experience_entries ADD COLUMN source_kind TEXT;

-- episodes 路径质量字段
ALTER TABLE episodes ADD COLUMN invalid_tool_calls INTEGER NOT NULL DEFAULT 0;
ALTER TABLE episodes ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE episodes ADD COLUMN path_quality REAL;

-- 索引: 验证状态检索
CREATE INDEX IF NOT EXISTS idx_experience_verified ON experience_entries(verified, use_count DESC);
