-- 0092: durable AgencyAction execution lifecycle.
CREATE TABLE IF NOT EXISTS agency_runs (
  id TEXT PRIMARY KEY,
  correlation_id TEXT NOT NULL,
  causation_id TEXT,
  scope_key TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('global','chat','user','task')),
  chat_id INTEGER,
  user_id INTEGER,
  task_id TEXT,
  action_json TEXT NOT NULL,
  risk TEXT NOT NULL CHECK (risk IN ('read','reversible','irreversible')),
  idempotency_key TEXT NOT NULL UNIQUE,
  expected_outcome TEXT,
  max_ms INTEGER NOT NULL,
  max_llm_calls INTEGER NOT NULL,
  max_tool_calls INTEGER NOT NULL,
  expires_at INTEGER,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','waiting','succeeded','failed','cancelled','expired')),
  attempt INTEGER NOT NULL DEFAULT 0,
  result_json TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_agency_runs_status ON agency_runs(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_agency_runs_correlation ON agency_runs(correlation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_agency_runs_scope ON agency_runs(scope_key, created_at);
