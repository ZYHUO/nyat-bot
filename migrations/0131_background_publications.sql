CREATE TABLE IF NOT EXISTS background_checks (
  task_id TEXT PRIMARY KEY, chat_id INTEGER NOT NULL, platform TEXT NOT NULL,
  account_id TEXT NOT NULL, thread_id INTEGER NOT NULL, origin_kind TEXT NOT NULL,
  origin_key TEXT NOT NULL, origin_hash TEXT NOT NULL, since_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL CHECK(state IN ('pending','running','closed','cancelled')),
  owner TEXT, reason TEXT
);
CREATE TABLE IF NOT EXISTS background_evidence (
  handle TEXT PRIMARY KEY, task_id TEXT NOT NULL, proof_json TEXT NOT NULL,
  FOREIGN KEY(task_id) REFERENCES background_checks(task_id)
);
CREATE TABLE IF NOT EXISTS background_publications (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL UNIQUE, version INTEGER NOT NULL,
  text TEXT NOT NULL, text_hash TEXT NOT NULL, handles_json TEXT NOT NULL,
  evidence_hash TEXT NOT NULL, state TEXT NOT NULL
    CHECK(state IN ('proposed','sending','sent','suppressed','failed','unknown')),
  created_at INTEGER NOT NULL, attempted_at INTEGER, receipt_json TEXT, reason TEXT,
  FOREIGN KEY(task_id) REFERENCES background_checks(task_id)
);
CREATE INDEX IF NOT EXISTS background_checks_scope ON background_checks(platform,account_id,chat_id,thread_id,origin_kind,origin_key);
CREATE INDEX IF NOT EXISTS background_publications_budget ON background_publications(state,attempted_at);
