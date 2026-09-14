-- 0104: append-only group norm history for event-anchored projections.
-- group_norms remains the fast current snapshot; this ledger preserves the
-- bounded norm text and sample count observed at each update.

CREATE TABLE IF NOT EXISTS group_norm_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  norms TEXT NOT NULL,
  sample_count INTEGER NOT NULL CHECK (sample_count >= 0),
  last_updated_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  legacy INTEGER NOT NULL DEFAULT 0 CHECK (legacy IN (0, 1)),
  UNIQUE(chat_id, revision)
);

CREATE INDEX IF NOT EXISTS idx_group_norm_revisions_chat_time
  ON group_norm_revisions(chat_id, last_updated_at DESC, revision DESC);

-- Existing rows have one known snapshot only. Do not infer any older norm.
INSERT INTO group_norm_revisions (
  chat_id, revision, norms, sample_count, last_updated_at, created_at, legacy
)
SELECT
  g.chat_id, 1, g.norms, MAX(0, g.sample_count), g.last_updated_at, g.created_at, 1
FROM group_norms g
WHERE NOT EXISTS (
  SELECT 1 FROM group_norm_revisions r WHERE r.chat_id = g.chat_id
);

CREATE TRIGGER IF NOT EXISTS group_norms_revision_after_insert
AFTER INSERT ON group_norms
BEGIN
  INSERT INTO group_norm_revisions (
    chat_id, revision, norms, sample_count, last_updated_at, created_at, legacy
  )
  VALUES (
    NEW.chat_id,
    COALESCE((SELECT MAX(revision) + 1 FROM group_norm_revisions WHERE chat_id = NEW.chat_id), 1),
    NEW.norms,
    MAX(0, NEW.sample_count),
    NEW.last_updated_at,
    NEW.created_at,
    0
  );
END;

CREATE TRIGGER IF NOT EXISTS group_norms_revision_after_update
AFTER UPDATE OF norms, sample_count, last_updated_at ON group_norms
WHEN OLD.norms IS NOT NEW.norms
  OR OLD.sample_count IS NOT NEW.sample_count
  OR OLD.last_updated_at IS NOT NEW.last_updated_at
BEGIN
  INSERT INTO group_norm_revisions (
    chat_id, revision, norms, sample_count, last_updated_at, created_at, legacy
  )
  VALUES (
    NEW.chat_id,
    COALESCE((SELECT MAX(revision) + 1 FROM group_norm_revisions WHERE chat_id = NEW.chat_id), 1),
    NEW.norms,
    MAX(0, NEW.sample_count),
    NEW.last_updated_at,
    NEW.created_at,
    0
  );
END;
