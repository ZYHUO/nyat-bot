-- Durable scope/stream cursors for restart-safe event projections.
-- `cognitive_events.sequence` is correlation-local, so recovery uses the
-- occurred_at/event-id tuple as a monotonic position within an exact scope.
CREATE TABLE IF NOT EXISTS cognitive_cursors (
  scope_key TEXT NOT NULL,
  stream TEXT NOT NULL,
  occurred_at INTEGER NOT NULL DEFAULT 0,
  event_id TEXT,
  lease_owner TEXT,
  lease_until INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (scope_key, stream)
);

CREATE INDEX IF NOT EXISTS idx_cognitive_cursors_lease
  ON cognitive_cursors(lease_until, updated_at);
