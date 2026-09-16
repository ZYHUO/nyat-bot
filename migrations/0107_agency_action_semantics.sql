-- 0107: explicit Agency action anchor/trigger/obligation semantics.
-- These fields are host-owned metadata only. They never grant authority and
-- live in a side table so applying the migration remains idempotent on SQLite.

CREATE TABLE IF NOT EXISTS agency_action_semantics (
  run_id TEXT PRIMARY KEY,
  anchor_event_id TEXT NOT NULL,
  trigger_event_id TEXT NOT NULL,
  obligation_id TEXT NOT NULL,
  action_source TEXT NOT NULL CHECK (action_source IN ('reply','heart','meta','timing','codeact','core','scheduler','legacy')),
  created_at INTEGER NOT NULL,
  FOREIGN KEY (run_id) REFERENCES agency_runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_agency_action_semantics_anchor
  ON agency_action_semantics(anchor_event_id, created_at);
CREATE INDEX IF NOT EXISTS idx_agency_action_semantics_obligation
  ON agency_action_semantics(obligation_id, created_at);
