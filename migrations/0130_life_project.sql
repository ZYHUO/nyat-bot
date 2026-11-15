-- Bounded digital creation. Historical account/actor provenance is never inferred.
CREATE TABLE IF NOT EXISTS life_projects (
  id TEXT PRIMARY KEY,
  chat_id INTEGER NOT NULL,
  platform TEXT NOT NULL CHECK(platform IN ('telegram','qq')),
  account_id TEXT NOT NULL,
  mission_id TEXT NOT NULL UNIQUE,
  activation_event_id TEXT NOT NULL,
  objective TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','completed','exhausted','cancelled','held')),
  created_at INTEGER NOT NULL,
  deadline_at INTEGER NOT NULL,
  next_due_at INTEGER NOT NULL,
  max_attempts INTEGER NOT NULL CHECK(max_attempts BETWEEN 1 AND 8),
  attempts_started INTEGER NOT NULL DEFAULT 0 CHECK(attempts_started BETWEEN 0 AND 8)
);
CREATE UNIQUE INDEX IF NOT EXISTS life_project_one_active_scope
  ON life_projects(platform,account_id,chat_id) WHERE status IN ('active','held');
CREATE TABLE IF NOT EXISTS life_project_attempts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES life_projects(id),
  ordinal INTEGER NOT NULL,
  wake_event_id TEXT NOT NULL UNIQUE,
  owner_token TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running','succeeded','failed','unknown','cancelled')),
  started_at INTEGER NOT NULL,
  lease_until INTEGER NOT NULL,
  finished_at INTEGER,
  llm_requests INTEGER NOT NULL DEFAULT 0 CHECK(llm_requests BETWEEN 0 AND 2),
  artifact_name TEXT,
  artifact_sha256 TEXT,
  artifact_bytes INTEGER,
  result_code TEXT,
  outcome_event_id TEXT,
  UNIQUE(project_id,ordinal)
);
CREATE UNIQUE INDEX IF NOT EXISTS life_project_one_running_attempt
  ON life_project_attempts(project_id) WHERE status='running';
