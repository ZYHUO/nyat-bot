-- 0091: durable projection/outbox delivery for cognitive events.
-- Redis/BullMQ may wake a worker, but this table remains the source of truth
-- across crashes and lets consumers ack/retry idempotently.
CREATE TABLE IF NOT EXISTS cognitive_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE REFERENCES cognitive_events(id) ON DELETE CASCADE,
  topic TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','delivered','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at INTEGER NOT NULL,
  locked_at INTEGER,
  locked_by TEXT,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cognitive_outbox_pending
  ON cognitive_outbox(status, available_at, id);
CREATE INDEX IF NOT EXISTS idx_cognitive_outbox_event
  ON cognitive_outbox(event_id);
