-- Host-owned conversation lanes. These are Attention state, not a second queue.
CREATE TABLE IF NOT EXISTS pending_reply_intents (
  lane_key TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  account_id TEXT NOT NULL,
  chat_id INTEGER NOT NULL,
  sender_id INTEGER NOT NULL,
  thread_id INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','held','cancelled','settled')),
  first_at INTEGER NOT NULL,
  changed_at INTEGER NOT NULL,
  confirmed_revision INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS pending_reply_sources (
  source_key TEXT PRIMARY KEY,
  lane_key TEXT NOT NULL,
  intent_id TEXT NOT NULL,
  message_id INTEGER NOT NULL,
  sender_id INTEGER NOT NULL,
  event_id TEXT NOT NULL,
  source_revision TEXT NOT NULL,
  edited_at INTEGER,
  received_at INTEGER NOT NULL,
  intent_revision INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pending_reply_sources_intent ON pending_reply_sources(intent_id, message_id);
CREATE TABLE IF NOT EXISTS pending_reply_events (
  event_id TEXT PRIMARY KEY,
  binding_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pending_reply_retired (
  intent_id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK(state IN ('cancelled','settled','superseded')),
  retired_at INTEGER NOT NULL
);
