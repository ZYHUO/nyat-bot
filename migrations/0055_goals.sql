CREATE TABLE IF NOT EXISTS goals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic TEXT NOT NULL,
  origin TEXT NOT NULL,
  chat_id INTEGER,
  status TEXT NOT NULL DEFAULT 'active',
  check_interval_sec INTEGER DEFAULT 86400,
  last_check_at INTEGER,
  last_finding TEXT,
  findings_count INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_goals_status_due ON goals(status, last_check_at);
