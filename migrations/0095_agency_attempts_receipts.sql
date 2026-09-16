-- 0095: durable attempts and execution receipts for Agency runs.
-- A run is the logical idempotent action; an attempt is one adapter invocation;
-- the receipt is the host-owned settlement fact exposed to replay/audit tools.

CREATE TABLE IF NOT EXISTS agency_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  attempt_no INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running','succeeded','failed','cancelled','expired')),
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  result_json TEXT,
  error TEXT,
  UNIQUE(run_id, attempt_no)
);
CREATE INDEX IF NOT EXISTS idx_agency_attempts_run ON agency_attempts(run_id, attempt_no);

CREATE TABLE IF NOT EXISTS execution_receipts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  attempt_id INTEGER,
  status TEXT NOT NULL CHECK (status IN ('succeeded','failed','cancelled','expired')),
  result_json TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(run_id, attempt_id)
);
CREATE INDEX IF NOT EXISTS idx_execution_receipts_run ON execution_receipts(run_id, created_at);
