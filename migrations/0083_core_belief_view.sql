-- ============================================
-- Phase 0 Task 0.1: Belief View 读投影 (Core v2)
-- 旧表继续写，这里只是统一读接口。不改任何旧表。
-- ============================================

CREATE TABLE IF NOT EXISTS core_beliefs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_table TEXT NOT NULL,
  source_row_id INTEGER NOT NULL,
  predicate TEXT NOT NULL,
  summary TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.5,
  support_count INTEGER NOT NULL DEFAULT 0,
  refute_count INTEGER NOT NULL DEFAULT 0,
  last_confirmed_at INTEGER,
  ttl_sec INTEGER NOT NULL DEFAULT 7776000,
  status TEXT NOT NULL DEFAULT 'active',
  evidence TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_beliefs_status ON core_beliefs(status, predicate);
CREATE INDEX IF NOT EXISTS idx_beliefs_source ON core_beliefs(source_table, source_row_id);
