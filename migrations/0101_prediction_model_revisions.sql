-- 0101: Append-only host calibration revisions for prediction dimensions.
-- A revision is emitted only after a bounded minimum of resolved outcomes; it
-- records evidence for a future calibration consumer without changing replies.
CREATE TABLE IF NOT EXISTS prediction_model_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  user_id INTEGER,
  action_type TEXT,
  sample_count INTEGER NOT NULL CHECK (sample_count > 0),
  mean_error REAL NOT NULL CHECK (mean_error >= -2 AND mean_error <= 2),
  previous_bias REAL NOT NULL CHECK (previous_bias >= -0.75 AND previous_bias <= 0.75),
  new_bias REAL NOT NULL CHECK (new_bias >= -0.75 AND new_bias <= 0.75),
  source_prediction_id INTEGER NOT NULL,
  outcome_event_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_prediction_model_revision_prediction
  ON prediction_model_revisions(source_prediction_id);
CREATE INDEX IF NOT EXISTS idx_prediction_model_revision_dimension
  ON prediction_model_revisions(chat_id, user_id, action_type, created_at DESC, id DESC);
