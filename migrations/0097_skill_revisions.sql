-- 0097: versioned skill artifact and release ledger.
-- core_skill_lifecycle remains the state-machine gate; this table preserves
-- the exact candidate, verification evidence and rollback reason per version.

ALTER TABLE core_skill_lifecycle ADD COLUMN revision_id INTEGER;
ALTER TABLE core_skill_lifecycle ADD COLUMN rollback_reason TEXT;

CREATE TABLE IF NOT EXISTS skill_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lifecycle_id INTEGER NOT NULL,
  skill_id INTEGER,
  name TEXT NOT NULL,
  version INTEGER NOT NULL,
  scope_key TEXT NOT NULL DEFAULT 'global',
  artifact_json TEXT NOT NULL,
  source_episode_ids TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'candidate'
    CHECK (status IN ('candidate','verified','approved','published','rejected','deprecated','rolled_back')),
  test_summary TEXT,
  rollback_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(lifecycle_id, version)
);
CREATE INDEX IF NOT EXISTS idx_skill_revisions_name_version
  ON skill_revisions(name, version DESC);
CREATE INDEX IF NOT EXISTS idx_skill_revisions_status
  ON skill_revisions(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_skill_revisions_lifecycle
  ON skill_revisions(lifecycle_id, version DESC);
