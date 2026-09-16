-- 0100: Dimensions for prediction calibration.
-- Existing rows remain valid with NULL dimensions; new host records may carry
-- the target user and the concrete Agency action type for grouped evaluation.

ALTER TABLE bot_predictions ADD COLUMN user_id INTEGER;
ALTER TABLE bot_predictions ADD COLUMN action_type TEXT;

CREATE INDEX IF NOT EXISTS idx_predictions_dimensions
  ON bot_predictions(chat_id, user_id, action_type, resolved_at, created_at DESC);
