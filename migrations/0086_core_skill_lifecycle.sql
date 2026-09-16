-- ============================================
-- Phase 4 Task 1: core skill lifecycle (Core v2)
-- skills 旧表继续当"能力库"(唯一真相)；
-- core_skill_lifecycle 管"候选→验证→人审→发布"的门。
-- 纯增量表。
-- ============================================

CREATE TABLE IF NOT EXISTS core_skill_lifecycle (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed',
  -- proposed → verified → approved → published
  --              ↓fail      ↓reject
  --           rejected
  verify_log TEXT,
  reviewer INTEGER,
  reviewed_at INTEGER,
  skill_id INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_skill_lifecycle_status ON core_skill_lifecycle(status);
