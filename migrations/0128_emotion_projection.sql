-- Event-backed emotion state remains rebuildable; no copied private narrative.
-- Supports exact-scope, time-bounded latest-version reads.
CREATE INDEX IF NOT EXISTS idx_emotion_event_scope_time
  ON cognitive_events(scope_key, type, occurred_at DESC)
  WHERE type IN ('inner_state_updated', 'affect_episode_updated');
