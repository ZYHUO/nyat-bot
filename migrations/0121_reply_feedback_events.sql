-- One durable settlement per scoped bot reply. The source identifies the actual
-- observer; the original trigger user is retained separately and is not blamed.
CREATE TABLE IF NOT EXISTS reply_feedback_events (
  event_id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL,
  chat_id INTEGER NOT NULL,
  bot_message_id INTEGER NOT NULL,
  source_message_id INTEGER NOT NULL,
  actor_uid INTEGER NOT NULL,
  actor_is_bot INTEGER NOT NULL CHECK(actor_is_bot IN (0, 1)),
  trigger_uid INTEGER NOT NULL,
  attribution TEXT NOT NULL,
  confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  outcome TEXT NOT NULL,
  signal TEXT NOT NULL,
  -- Retention may remove narrative rows; keep the idempotency receipt forever.
  outcome_id INTEGER REFERENCES reply_outcomes(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(scope_key, bot_message_id)
);

-- Deduplicate window observations even when Redis cleanup or the process fails.
CREATE TABLE IF NOT EXISTS reply_feedback_observations (
  scope_key TEXT NOT NULL,
  bot_message_id INTEGER NOT NULL,
  source_message_id INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  PRIMARY KEY(scope_key, bot_message_id, source_message_id)
);
CREATE INDEX IF NOT EXISTS idx_reply_feedback_observation_time
  ON reply_feedback_observations(observed_at);

-- Optional learning is outside the primary feedback transaction. A claimed
-- effect after a crash is unconfirmed, never automatically replayed: some legacy
-- consumers are not idempotent. This is an auditable outbox, not exactly-once IO.
CREATE TABLE IF NOT EXISTS reply_feedback_effects (
  event_id TEXT NOT NULL REFERENCES reply_feedback_events(event_id),
  kind TEXT NOT NULL CHECK(kind IN ('self_history', 'route', 'asi', 'echo')),
  chat_id INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending', 'claimed', 'completed', 'failed')),
  created_at INTEGER NOT NULL,
  claimed_at INTEGER,
  completed_at INTEGER,
  last_error TEXT,
  PRIMARY KEY(event_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_reply_feedback_effect_pending
  ON reply_feedback_effects(chat_id, state, created_at);
