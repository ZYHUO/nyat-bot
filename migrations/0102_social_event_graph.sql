-- 0102: indexed, replayable social interaction events.
-- The event log remains the source of truth; this index only makes exact chat
-- graph reads bounded without introducing a second mutable social store.
CREATE INDEX IF NOT EXISTS idx_cognitive_events_social_scope_time
  ON cognitive_events(type, chat_id, occurred_at DESC, id);
