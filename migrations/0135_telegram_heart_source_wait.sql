-- A passive Telegram WAIT keeps its original intake row and first deadline.
-- NULL on existing rows preserves their original fresh/recovery behavior.
ALTER TABLE telegram_heart_candidates ADD COLUMN wait_until_ms INTEGER;
ALTER TABLE telegram_heart_candidates ADD COLUMN reviewed_early INTEGER NOT NULL DEFAULT 0;
-- Limited handoff between a WAIT decision and its final reply task.
ALTER TABLE telegram_heart_candidates ADD COLUMN wait_attention_key TEXT;
ALTER TABLE telegram_heart_candidates ADD COLUMN wait_source_hash TEXT;
ALTER TABLE telegram_heart_candidates ADD COLUMN wait_source_layer TEXT;
ALTER TABLE telegram_heart_candidates ADD COLUMN wait_attention_entered INTEGER NOT NULL DEFAULT 0;
ALTER TABLE telegram_heart_candidates ADD COLUMN wait_redriven INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_telegram_heart_source_wait
  ON telegram_heart_candidates(scope_key,wait_until_ms,sequence)
  WHERE state='pending' AND wait_until_ms IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_telegram_heart_due
  ON telegram_heart_candidates(wait_until_ms,sequence)
  WHERE state='pending' AND wait_until_ms IS NOT NULL;

-- Invalidates an old WAIT approval after a new event or direct interruption.
CREATE TABLE IF NOT EXISTS telegram_heart_scope_versions (
  scope_key TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  cancel_version INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO telegram_heart_scope_versions(scope_key,version)
  SELECT DISTINCT scope_key,1 FROM telegram_heart_candidates WHERE state IN ('pending','evaluating');
