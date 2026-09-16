-- 0099: append-only cognitive debt history for event-anchored replay.
-- Existing rows receive one legacy snapshot at their current updated_at. That
-- snapshot is deliberately not usable to invent an older state; readers only
-- use it when the anchor is at/after the recorded timestamp.

CREATE TABLE IF NOT EXISTS cognitive_debt_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  debt_id INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  chat_id INTEGER NOT NULL,
  owner_uid INTEGER,
  task_id TEXT,
  kind TEXT NOT NULL,
  statement TEXT NOT NULL,
  source_event_ids TEXT NOT NULL DEFAULT '[]',
  priority INTEGER NOT NULL,
  confidence REAL NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open','resolved','superseded','expired')),
  resolution TEXT,
  resolution_event_id TEXT,
  superseded_by INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  next_check_at INTEGER,
  expires_at INTEGER,
  scope_key TEXT,
  visibility TEXT,
  dedupe_key TEXT,
  snapshot_at INTEGER NOT NULL,
  legacy INTEGER NOT NULL DEFAULT 0 CHECK (legacy IN (0, 1)),
  UNIQUE(debt_id, revision)
);

CREATE INDEX IF NOT EXISTS idx_debt_revisions_lookup
  ON cognitive_debt_revisions(debt_id, snapshot_at DESC, revision DESC);
CREATE INDEX IF NOT EXISTS idx_debt_revisions_scope
  ON cognitive_debt_revisions(scope_key, status, snapshot_at DESC);

-- Do not claim that a pre-history row had an open/resolved transition before
-- the only state we know. The legacy bit lets callers surface that limitation.
INSERT INTO cognitive_debt_revisions (
  debt_id, revision, chat_id, owner_uid, task_id, kind, statement,
  source_event_ids, priority, confidence, status, resolution, resolution_event_id,
  superseded_by, created_at, updated_at, next_check_at, expires_at,
  scope_key, visibility, dedupe_key, snapshot_at, legacy
)
SELECT
  d.id, 1, d.chat_id, d.owner_uid, d.task_id, d.kind, d.statement,
  d.source_event_ids, d.priority, d.confidence, d.status, d.resolution, d.resolution_event_id,
  d.superseded_by, d.created_at, d.updated_at, d.next_check_at, d.expires_at,
  d.scope_key, d.visibility, d.dedupe_key, d.updated_at, 1
FROM cognitive_debts d
WHERE NOT EXISTS (
  SELECT 1 FROM cognitive_debt_revisions r WHERE r.debt_id = d.id
);

CREATE TRIGGER IF NOT EXISTS cognitive_debts_revision_after_insert
AFTER INSERT ON cognitive_debts
BEGIN
  INSERT INTO cognitive_debt_revisions (
    debt_id, revision, chat_id, owner_uid, task_id, kind, statement,
    source_event_ids, priority, confidence, status, resolution, resolution_event_id,
    superseded_by, created_at, updated_at, next_check_at, expires_at,
    scope_key, visibility, dedupe_key, snapshot_at, legacy
  )
  VALUES (
    NEW.id,
    COALESCE((SELECT MAX(revision) + 1 FROM cognitive_debt_revisions WHERE debt_id = NEW.id), 1),
    NEW.chat_id, NEW.owner_uid, NEW.task_id, NEW.kind, NEW.statement,
    NEW.source_event_ids, NEW.priority, NEW.confidence, NEW.status, NEW.resolution, NEW.resolution_event_id,
    NEW.superseded_by, NEW.created_at, NEW.updated_at, NEW.next_check_at, NEW.expires_at,
    NEW.scope_key, NEW.visibility, NEW.dedupe_key, NEW.updated_at, 0
  );
END;

CREATE TRIGGER IF NOT EXISTS cognitive_debts_revision_after_update
AFTER UPDATE OF owner_uid, task_id, kind, statement, source_event_ids, priority,
  confidence, status, resolution, resolution_event_id, superseded_by, updated_at,
  next_check_at, expires_at, scope_key, visibility, dedupe_key ON cognitive_debts
WHEN OLD.owner_uid IS NOT NEW.owner_uid
  OR OLD.task_id IS NOT NEW.task_id
  OR OLD.kind IS NOT NEW.kind
  OR OLD.statement IS NOT NEW.statement
  OR OLD.source_event_ids IS NOT NEW.source_event_ids
  OR OLD.priority IS NOT NEW.priority
  OR OLD.confidence IS NOT NEW.confidence
  OR OLD.status IS NOT NEW.status
  OR OLD.resolution IS NOT NEW.resolution
  OR OLD.resolution_event_id IS NOT NEW.resolution_event_id
  OR OLD.superseded_by IS NOT NEW.superseded_by
  OR OLD.updated_at IS NOT NEW.updated_at
  OR OLD.next_check_at IS NOT NEW.next_check_at
  OR OLD.expires_at IS NOT NEW.expires_at
  OR OLD.scope_key IS NOT NEW.scope_key
  OR OLD.visibility IS NOT NEW.visibility
  OR OLD.dedupe_key IS NOT NEW.dedupe_key
BEGIN
  INSERT INTO cognitive_debt_revisions (
    debt_id, revision, chat_id, owner_uid, task_id, kind, statement,
    source_event_ids, priority, confidence, status, resolution, resolution_event_id,
    superseded_by, created_at, updated_at, next_check_at, expires_at,
    scope_key, visibility, dedupe_key, snapshot_at, legacy
  )
  VALUES (
    NEW.id,
    COALESCE((SELECT MAX(revision) + 1 FROM cognitive_debt_revisions WHERE debt_id = NEW.id), 1),
    NEW.chat_id, NEW.owner_uid, NEW.task_id, NEW.kind, NEW.statement,
    NEW.source_event_ids, NEW.priority, NEW.confidence, NEW.status, NEW.resolution, NEW.resolution_event_id,
    NEW.superseded_by, NEW.created_at, NEW.updated_at, NEW.next_check_at, NEW.expires_at,
    NEW.scope_key, NEW.visibility, NEW.dedupe_key, NEW.updated_at, 0
  );
END;
