-- Durable research ownership and resumable stages. Existing rows deliberately
-- have no account provenance: they remain readable but cannot auto-execute.
ALTER TABLE tasks ADD COLUMN source_platform TEXT;
ALTER TABLE tasks ADD COLUMN source_account_id TEXT;
ALTER TABLE tasks ADD COLUMN execution_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN cancel_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN wake_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN claim_owner TEXT;
ALTER TABLE tasks ADD COLUMN claim_until_ms INTEGER;
ALTER TABLE tasks ADD COLUMN agency_run_id TEXT;
ALTER TABLE tasks ADD COLUMN delivery_state TEXT NOT NULL DEFAULT 'none';
ALTER TABLE tasks ADD COLUMN delivery_version INTEGER;
ALTER TABLE tasks ADD COLUMN delivery_receipt TEXT;

CREATE TABLE IF NOT EXISTS research_task_steps (
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  step_key TEXT NOT NULL,
  input_json TEXT NOT NULL,
  result_json TEXT NOT NULL,
  completed_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, step_key)
);
CREATE INDEX IF NOT EXISTS idx_tasks_expired_claim ON tasks(state, claim_until_ms, id);
CREATE INDEX IF NOT EXISTS idx_tasks_due_generation ON tasks(state, next_wake, wake_generation, id);
CREATE INDEX IF NOT EXISTS idx_cognitive_events_type_time_id ON cognitive_events(type, occurred_at, id);
