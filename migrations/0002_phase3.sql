-- ============================================
-- Phase 3: Tracking tables (tool + tracking systems)
-- ============================================

-- Bot interaction records (replaces JSONL files)
CREATE TABLE IF NOT EXISTS bot_interactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  bot_username TEXT NOT NULL,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  uid INTEGER,
  text TEXT,
  mid INTEGER NOT NULL,
  reply_to_mid INTEGER
);

CREATE INDEX IF NOT EXISTS idx_bot_interactions_chat_bot ON bot_interactions(chat_id, bot_username);

-- Bot digests (per-group)
CREATE TABLE IF NOT EXISTS bot_digests (
  chat_id INTEGER NOT NULL,
  bot_username TEXT NOT NULL,
  digest_md TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (chat_id, bot_username)
);

-- Bot global digests (cross-group)
CREATE TABLE IF NOT EXISTS bot_global_digests (
  bot_username TEXT PRIMARY KEY,
  digest_md TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Bot interaction metadata
CREATE TABLE IF NOT EXISTS bot_interaction_meta (
  chat_id INTEGER NOT NULL,
  bot_username TEXT NOT NULL,
  raw_count INTEGER NOT NULL DEFAULT 0,
  digested_count INTEGER NOT NULL DEFAULT 0,
  last_digest_ts INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (chat_id, bot_username)
);

-- Reply outcomes (replaces JSONL files)
CREATE TABLE IF NOT EXISTS reply_outcomes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  trigger_text TEXT,
  reply_text TEXT,
  outcome TEXT NOT NULL,
  signal TEXT NOT NULL,
  action TEXT
);

CREATE INDEX IF NOT EXISTS idx_reply_outcomes_chat ON reply_outcomes(chat_id);

-- Reply reflections (AI-generated self-reflection)
CREATE TABLE IF NOT EXISTS reply_reflections (
  chat_id INTEGER PRIMARY KEY,
  reflection TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Outcome tracking metadata
CREATE TABLE IF NOT EXISTS outcome_meta (
  chat_id INTEGER PRIMARY KEY,
  outcomes_since_reflection INTEGER NOT NULL DEFAULT 0,
  last_reflection_time INTEGER NOT NULL DEFAULT 0,
  total_reflections INTEGER NOT NULL DEFAULT 0,
  total_outcomes INTEGER NOT NULL DEFAULT 0
);
