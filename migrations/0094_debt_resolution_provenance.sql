-- 0094: resolution provenance for cognitive debts.
-- A debt may only be settled by an explicit host-observable event; keeping the
-- event id separate from the human-readable resolution makes replay/audit
-- possible without parsing prose.

ALTER TABLE cognitive_debts ADD COLUMN resolution_event_id TEXT;

CREATE INDEX IF NOT EXISTS idx_debts_resolution_event
  ON cognitive_debts(resolution_event_id);
