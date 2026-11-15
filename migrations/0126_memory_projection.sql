-- The source body is authoritative. Vector/FTS rows are disposable projections.
CREATE TABLE IF NOT EXISTS memory_sources (
  source_id TEXT PRIMARY KEY,
  legacy_id TEXT NOT NULL,
  platform TEXT NOT NULL CHECK(platform IN ('telegram', 'qq')),
  account_id TEXT NOT NULL,
  chat_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  thread_id INTEGER,
  body_json TEXT NOT NULL,
  text_body TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK(visibility IN ('private', 'contextual', 'public')),
  version INTEGER NOT NULL,
  event_id TEXT,
  input_revision TEXT,
  event_order_ms INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  tombstone INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS memory_sources_legacy ON memory_sources(legacy_id);
CREATE TABLE IF NOT EXISTS memory_source_events (
  event_id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES memory_sources(source_id),
  version INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_projection_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL REFERENCES memory_sources(source_id),
  version INTEGER NOT NULL,
  model TEXT NOT NULL,
  collection TEXT NOT NULL,
  projection_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','done','failed','superseded')),
  vector_done INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  lease_token TEXT,
  lease_until INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  UNIQUE(source_id, version, model, collection)
);
CREATE INDEX IF NOT EXISTS memory_projection_due ON memory_projection_jobs(state, next_attempt_at, lease_until);
-- Also suppress old Qdrant rows which predate source IDs. Do not relabel them.
CREATE TABLE IF NOT EXISTS memory_retractions (
  legacy_id TEXT PRIMARY KEY,
  retracted_at INTEGER NOT NULL
);
