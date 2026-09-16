-- 0109: host-evidence gate for Self/Person/Group/World hypothesis updates.
-- Model-authored claims are retained only as candidates/rejections and never
-- become active projection rows without a host-owned source event.

CREATE TABLE IF NOT EXISTS hypothesis_update_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  idempotency_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('self','person','group','world')),
  scope_key TEXT NOT NULL,
  subject_key TEXT NOT NULL,
  source_event_id TEXT,
  source TEXT NOT NULL CHECK (source IN ('host','tool','telegram','scheduler','import','model')),
  status TEXT NOT NULL CHECK (status IN ('accepted','rejected','candidate')),
  reason TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  counterevidence_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_hypothesis_update_audit_scope_time
  ON hypothesis_update_audit(scope_key, created_at DESC, kind);
CREATE INDEX IF NOT EXISTS idx_hypothesis_update_audit_source_event
  ON hypothesis_update_audit(source_event_id, created_at DESC);

-- Active Self projection requires a separate verified provenance row. Keeping
-- this side table avoids rewriting the original self_model_notes migration and
-- leaves old rows explicitly unverified when the new migration is introduced.
CREATE TABLE IF NOT EXISTS self_model_note_evidence (
  note_id INTEGER PRIMARY KEY,
  source_event_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('host','tool','telegram','scheduler','import')),
  evidence_json TEXT NOT NULL DEFAULT '{}',
  verified_at INTEGER NOT NULL,
  FOREIGN KEY (note_id) REFERENCES self_model_notes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_self_model_note_evidence_event
  ON self_model_note_evidence(source_event_id, verified_at DESC);
