-- 0089: append-only cognitive event log (AGI-003)
-- Facts are bounded JSON snapshots; raw message content is intentionally not
-- required so the log can be replayed without becoming a second message store.
CREATE TABLE IF NOT EXISTS cognitive_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('global','chat','user','task')),
  chat_id INTEGER,
  user_id INTEGER,
  task_id TEXT,
  source TEXT NOT NULL CHECK (source IN ('telegram','host','scheduler','tool','model','import')),
  occurred_at INTEGER NOT NULL,
  sequence INTEGER NOT NULL,
  causation_id TEXT,
  correlation_id TEXT NOT NULL,
  dedupe_key TEXT,
  fact_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cognitive_events_dedupe
  ON cognitive_events(dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_cognitive_events_sequence
  ON cognitive_events(correlation_id, sequence);
CREATE INDEX IF NOT EXISTS idx_cognitive_events_scope_time
  ON cognitive_events(scope_key, occurred_at, id);
CREATE INDEX IF NOT EXISTS idx_cognitive_events_correlation
  ON cognitive_events(correlation_id, sequence);
