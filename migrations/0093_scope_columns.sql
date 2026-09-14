-- 0093: Scope and provenance for cognitive debts and predictions.
-- Existing rows remain readable. Legacy prediction rows intentionally keep
-- predicted_signed NULL so their historical error semantics are unchanged;
-- newly recorded rows use the signed scale for comparable calibration.

ALTER TABLE cognitive_debts ADD COLUMN scope_key TEXT;
ALTER TABLE cognitive_debts ADD COLUMN visibility TEXT NOT NULL DEFAULT 'chat';
ALTER TABLE cognitive_debts ADD COLUMN dedupe_key TEXT;

UPDATE cognitive_debts
SET scope_key = CASE
  WHEN task_id IS NOT NULL AND task_id <> '' THEN 'task:' || task_id || '@chat:' || chat_id
  ELSE 'chat:' || chat_id
END
WHERE scope_key IS NULL;

UPDATE cognitive_debts
SET visibility = 'task'
WHERE task_id IS NOT NULL AND task_id <> '';

CREATE INDEX IF NOT EXISTS idx_debts_scope_status
  ON cognitive_debts(scope_key, status, priority DESC, updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_debts_dedupe
  ON cognitive_debts(dedupe_key)
  WHERE dedupe_key IS NOT NULL;

ALTER TABLE bot_predictions ADD COLUMN scope_key TEXT;
ALTER TABLE bot_predictions ADD COLUMN visibility TEXT NOT NULL DEFAULT 'chat';
ALTER TABLE bot_predictions ADD COLUMN source_event_id TEXT;
ALTER TABLE bot_predictions ADD COLUMN outcome_event_id TEXT;
ALTER TABLE bot_predictions ADD COLUMN prediction_scale TEXT NOT NULL DEFAULT 'legacy_probability';
ALTER TABLE bot_predictions ADD COLUMN predicted_signed REAL;

UPDATE bot_predictions
SET scope_key = 'chat:' || chat_id
WHERE scope_key IS NULL;

CREATE INDEX IF NOT EXISTS idx_predictions_scope
  ON bot_predictions(scope_key, resolved_at, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_predictions_source_event
  ON bot_predictions(source_event_id);
CREATE INDEX IF NOT EXISTS idx_predictions_outcome_event
  ON bot_predictions(outcome_event_id);
