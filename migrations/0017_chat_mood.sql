-- Migration 0017: chat_mood
-- Per-chat valence-based mood drift tracking. Ported design from MaiBot.
-- valence ∈ [-100, 100]. Higher = more cheerful.

CREATE TABLE IF NOT EXISTS chat_mood (
  chat_id            INTEGER PRIMARY KEY,
  valence            REAL    NOT NULL DEFAULT 0,
  last_event_at      INTEGER NOT NULL,
  last_decay_at      INTEGER NOT NULL,
  last_event_summary TEXT    NOT NULL DEFAULT ''
);
