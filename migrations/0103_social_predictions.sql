-- 0103: bounded social prediction and host-observed outcome ledger.
-- The ledger is metadata-only: no message body, prompt text or identity merge.
CREATE TABLE IF NOT EXISTS social_predictions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  target_user_id INTEGER,
  bot_message_id INTEGER NOT NULL,
  trigger_message_id INTEGER,
  expected_kind TEXT NOT NULL CHECK (expected_kind IN ('engagement', 'support', 'conflict', 'repair', 'silence')),
  expected_probability REAL NOT NULL CHECK (expected_probability >= 0 AND expected_probability <= 1),
  action_type TEXT,
  source_event_id TEXT,
  observed_kind TEXT,
  observed_score REAL,
  prediction_error REAL,
  outcome_event_id TEXT,
  resolved_at INTEGER,
  observation_window_sec INTEGER NOT NULL DEFAULT 86400 CHECK (observation_window_sec BETWEEN 60 AND 604800),
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_social_predictions_message_kind
  ON social_predictions(chat_id, bot_message_id, expected_kind);
CREATE INDEX IF NOT EXISTS idx_social_predictions_pending
  ON social_predictions(chat_id, resolved_at, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_social_predictions_target
  ON social_predictions(chat_id, target_user_id, resolved_at, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_social_predictions_outcome
  ON social_predictions(outcome_event_id);
