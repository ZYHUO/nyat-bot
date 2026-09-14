-- 0096: append-only world-model history.
-- The current world_entities row remains the fast read projection. Every
-- accepted revision can be retained here so replay/evaluators can explain
-- which evidence changed an entity and when it became stale.

ALTER TABLE world_entities ADD COLUMN current_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE world_entities ADD COLUMN source_event_id TEXT;
ALTER TABLE world_entities ADD COLUMN confidence REAL NOT NULL DEFAULT 0.5;
ALTER TABLE world_entities ADD COLUMN expires_at INTEGER;

CREATE TABLE IF NOT EXISTS world_entity_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  scope_key TEXT NOT NULL,
  source_event_id TEXT,
  properties_json TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.5,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','stale','contradicted','superseded','expired')),
  superseded_by INTEGER,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  UNIQUE(entity_id, revision)
);
CREATE INDEX IF NOT EXISTS idx_world_entity_revisions_entity
  ON world_entity_revisions(entity_id, revision DESC);
CREATE INDEX IF NOT EXISTS idx_world_entity_revisions_scope
  ON world_entity_revisions(scope_key, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_world_entity_revisions_source
  ON world_entity_revisions(source_event_id);
