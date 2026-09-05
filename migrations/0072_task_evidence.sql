-- Completion is a scheduler fact, not evidence of goal achievement.
-- Historical episodes deliberately remain unverified; never backfill success.
CREATE TABLE IF NOT EXISTS task_evidence (
  task_id TEXT PRIMARY KEY,
  chat_id INTEGER NOT NULL,
  lifecycle TEXT NOT NULL,
  assessment TEXT NOT NULL CHECK (assessment IN ('verified', 'failed', 'unverified')),
  turns INTEGER NOT NULL DEFAULT 0,
  total_calls INTEGER NOT NULL DEFAULT 0,
  failed_calls INTEGER NOT NULL DEFAULT 0,
  retry_count INTEGER NOT NULL DEFAULT 0,
  reasons TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_evidence_chat_updated ON task_evidence(chat_id, updated_at);
