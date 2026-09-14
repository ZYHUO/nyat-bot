-- 0106: durable complexity-routing observations.
-- This is telemetry only. It never authorizes a route or a side effect.

CREATE TABLE IF NOT EXISTS cognitive_route_observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  trigger_message_id INTEGER NOT NULL,
  route TEXT NOT NULL CHECK (route IN ('fast', 'deep', 'background')),
  score INTEGER NOT NULL CHECK (score >= 0 AND score <= 100),
  primary_signal TEXT,
  behavior_applied INTEGER NOT NULL DEFAULT 0 CHECK (behavior_applied IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'classified'
    CHECK (status IN ('classified', 'sent', 'silent', 'failed', 'interrupted', 'blocked')),
  latency_ms INTEGER,
  tool_calls INTEGER,
  reply_count INTEGER,
  feedback_outcome TEXT CHECK (feedback_outcome IN ('positive', 'negative')),
  feedback_signal TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  UNIQUE(chat_id, trigger_message_id)
);

CREATE INDEX IF NOT EXISTS idx_cognitive_route_observations_window
  ON cognitive_route_observations(chat_id, created_at DESC, route);
CREATE INDEX IF NOT EXISTS idx_cognitive_route_observations_feedback
  ON cognitive_route_observations(chat_id, route, feedback_outcome, created_at DESC);
