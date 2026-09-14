-- 0098: replay/paired evaluation ledger.
-- Only bounded experiment configuration, outcome labels and numeric metrics
-- belong here. Event facts and private artifacts stay in their owner stores.

CREATE TABLE IF NOT EXISTS replay_experiments (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  code_version TEXT,
  config_json TEXT NOT NULL DEFAULT '{}',
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_replay_experiments_kind_time
  ON replay_experiments(kind, started_at DESC);

CREATE TABLE IF NOT EXISTS replay_experiment_cases (
  experiment_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  variant_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('verified','failed','unverified','blocked')),
  false_success INTEGER NOT NULL DEFAULT 0 CHECK (false_success IN (0,1)),
  human_intervention INTEGER NOT NULL DEFAULT 0 CHECK (human_intervention IN (0,1)),
  metrics_json TEXT NOT NULL DEFAULT '{}',
  error_code TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (experiment_id, case_id, variant_id),
  FOREIGN KEY (experiment_id) REFERENCES replay_experiments(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_replay_experiment_cases_variant
  ON replay_experiment_cases(experiment_id, variant_id, status);
