-- 0108: explicit boundary for pre-history cognitive debt rows.
-- The system cannot infer transitions before 0099. Preserve that limitation
-- as data instead of silently treating a legacy snapshot as a full history.

CREATE TABLE IF NOT EXISTS cognitive_debt_legacy_boundaries (
  debt_id INTEGER PRIMARY KEY,
  snapshot_at INTEGER NOT NULL,
  boundary_note TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO cognitive_debt_legacy_boundaries (debt_id, snapshot_at, boundary_note, created_at)
SELECT debt_id, snapshot_at,
       'Only the first captured snapshot is known; earlier open/resolved transitions are unavailable.',
       unixepoch()
FROM cognitive_debt_revisions
WHERE legacy = 1;

CREATE INDEX IF NOT EXISTS idx_cognitive_debt_legacy_boundaries_time
  ON cognitive_debt_legacy_boundaries(snapshot_at, debt_id);
