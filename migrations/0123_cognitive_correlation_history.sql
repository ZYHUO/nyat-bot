-- Full-history reconciliation uses event-time keyset pagination per correlation,
-- rather than the prompt's bounded window or the per-correlation sequence order.
CREATE INDEX IF NOT EXISTS idx_cognitive_events_correlation_type_time
  ON cognitive_events(correlation_id, type, occurred_at, id);
