-- ============================================
-- Phase 3 Task 1: core drives (Core v2)
-- connection | curiosity | competence | autonomy
-- value 0..1 + satiation 抑制项。纯增量表。
-- ============================================

CREATE TABLE IF NOT EXISTS core_drives (
  name TEXT PRIMARY KEY,
  value REAL NOT NULL DEFAULT 0.5,
  satiation REAL NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
