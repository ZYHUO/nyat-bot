-- 0105: append-only relationship snapshots for event-anchored projections.
-- chat_relationships remains the mutable current snapshot; this ledger records
-- bounded, metadata-only state so historical workspaces never read the future.

CREATE TABLE IF NOT EXISTS chat_relationship_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  uid INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  affinity REAL NOT NULL,
  interaction_count INTEGER NOT NULL CHECK (interaction_count >= 0),
  last_interaction_at INTEGER NOT NULL,
  last_summary TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  legacy INTEGER NOT NULL DEFAULT 0 CHECK (legacy IN (0, 1)),
  UNIQUE(chat_id, uid, revision)
);

CREATE INDEX IF NOT EXISTS idx_chat_relationship_revisions_scope_time
  ON chat_relationship_revisions(chat_id, uid, updated_at DESC, revision DESC);

-- Existing rows have one known snapshot only. Do not invent older events.
INSERT INTO chat_relationship_revisions (
  chat_id, uid, revision, affinity, interaction_count, last_interaction_at,
  last_summary, updated_at, created_at, legacy
)
SELECT
  r.chat_id,
  r.uid,
  1,
  r.affinity,
  MAX(0, r.interaction_count),
  r.last_interaction_at,
  COALESCE(r.last_summary, ''),
  r.updated_at,
  r.updated_at,
  1
FROM chat_relationships r
WHERE NOT EXISTS (
  SELECT 1
  FROM chat_relationship_revisions h
  WHERE h.chat_id = r.chat_id AND h.uid = r.uid
);

CREATE TRIGGER IF NOT EXISTS chat_relationships_revision_after_insert
AFTER INSERT ON chat_relationships
BEGIN
  INSERT INTO chat_relationship_revisions (
    chat_id, uid, revision, affinity, interaction_count, last_interaction_at,
    last_summary, updated_at, created_at, legacy
  )
  VALUES (
    NEW.chat_id,
    NEW.uid,
    COALESCE((
      SELECT MAX(revision) + 1
      FROM chat_relationship_revisions
      WHERE chat_id = NEW.chat_id AND uid = NEW.uid
    ), 1),
    NEW.affinity,
    MAX(0, NEW.interaction_count),
    NEW.last_interaction_at,
    COALESCE(NEW.last_summary, ''),
    NEW.updated_at,
    NEW.updated_at,
    0
  );
END;

CREATE TRIGGER IF NOT EXISTS chat_relationships_revision_after_update
AFTER UPDATE OF affinity, interaction_count, last_interaction_at, last_summary, updated_at
ON chat_relationships
WHEN OLD.affinity IS NOT NEW.affinity
  OR OLD.interaction_count IS NOT NEW.interaction_count
  OR OLD.last_interaction_at IS NOT NEW.last_interaction_at
  OR OLD.last_summary IS NOT NEW.last_summary
  OR OLD.updated_at IS NOT NEW.updated_at
BEGIN
  INSERT INTO chat_relationship_revisions (
    chat_id, uid, revision, affinity, interaction_count, last_interaction_at,
    last_summary, updated_at, created_at, legacy
  )
  VALUES (
    NEW.chat_id,
    NEW.uid,
    COALESCE((
      SELECT MAX(revision) + 1
      FROM chat_relationship_revisions
      WHERE chat_id = NEW.chat_id AND uid = NEW.uid
    ), 1),
    NEW.affinity,
    MAX(0, NEW.interaction_count),
    NEW.last_interaction_at,
    COALESCE(NEW.last_summary, ''),
    NEW.updated_at,
    NEW.updated_at,
    0
  );
END;
