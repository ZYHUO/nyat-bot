-- 0075: experience_entries 证据血缘列 (Phase 3 P3-1)
-- 每条经验记录产出它的 episode 的 outcome + host assessment,skill-distill
-- 只读 verified 血缘的经验,历史数据按 unverified 对待(默认排除)。
ALTER TABLE experience_entries ADD COLUMN source_outcome TEXT;
ALTER TABLE experience_entries ADD COLUMN source_assessment TEXT NOT NULL DEFAULT 'unverified';
CREATE INDEX IF NOT EXISTS idx_experience_source ON experience_entries(source_assessment, created_at DESC);
