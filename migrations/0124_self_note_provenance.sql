-- No backfill: old candidates and evidence links do not prove account/scope.
CREATE TABLE IF NOT EXISTS self_model_note_provenance (
  note_id INTEGER PRIMARY KEY REFERENCES self_model_notes(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('candidate', 'verified')),
  scope_key TEXT NOT NULL,
  conversation_json TEXT,
  source_refs_json TEXT NOT NULL DEFAULT '[]',
  origin TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_self_note_provenance_scope
  ON self_model_note_provenance(state, scope_key);

-- Keep promotion receipts after retention so replay cannot reinsert old notes.
CREATE TABLE IF NOT EXISTS self_model_note_promotions (
  source_event_id TEXT NOT NULL,
  note_hash TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  note_id INTEGER REFERENCES self_model_notes(id) ON DELETE SET NULL,
  verified_at INTEGER NOT NULL,
  PRIMARY KEY (source_event_id, note_hash, scope_key)
);
