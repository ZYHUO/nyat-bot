-- 0110: indexes for the event-sourced NyatOS kernel.
-- The event table remains the source of truth; these indexes only make frame
-- and envelope replay bounded on a long-running bot.
CREATE INDEX IF NOT EXISTS idx_cognitive_events_causation
  ON cognitive_events(causation_id, occurred_at, id);
CREATE INDEX IF NOT EXISTS idx_cognitive_events_kernel_scope_type
  ON cognitive_events(scope_key, type, occurred_at DESC, id);
