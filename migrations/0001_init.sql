-- xxb-ts initial schema
-- ────────────────────────────────────────

-- Message context storage
CREATE TABLE IF NOT EXISTS messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id       INTEGER NOT NULL,
  message_id    INTEGER NOT NULL,
  uid           INTEGER NOT NULL,
  username      TEXT    NOT NULL DEFAULT '',
  full_name     TEXT    NOT NULL DEFAULT '',
  role          TEXT    NOT NULL DEFAULT 'user',
  text_content  TEXT    NOT NULL DEFAULT '',
  caption       TEXT,
  is_forwarded  INTEGER NOT NULL DEFAULT 0,
  forward_from  TEXT,
  image_file_id TEXT,
  reply_to_msg  INTEGER,
  is_bot        INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(chat_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_messages_chat_ts
  ON messages(chat_id, created_at DESC);

-- Knowledge base entries
CREATE TABLE IF NOT EXISTS knowledge (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id    INTEGER NOT NULL,
  content    TEXT    NOT NULL,
  source     TEXT    NOT NULL DEFAULT 'summarize',
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_knowledge_chat
  ON knowledge(chat_id);

-- Sticker memory
CREATE TABLE IF NOT EXISTS sticker_memory (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id    TEXT    NOT NULL UNIQUE,
  set_name   TEXT,
  emoji      TEXT,
  intent     TEXT,
  keywords   TEXT,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Vector embeddings (requires sqlite-vec extension)
-- Uncomment when sqlite-vec is available:
-- CREATE VIRTUAL TABLE IF NOT EXISTS vec_messages USING vec0(
--   embedding float[1536]
-- );

-- Managed allowlist
CREATE TABLE IF NOT EXISTS allowlist (
  chat_id      INTEGER PRIMARY KEY,
  status       TEXT    NOT NULL DEFAULT 'pending',  -- pending | approved | rejected
  submitted_by INTEGER NOT NULL,
  reviewed_at  TEXT,
  enabled      INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Migration tracking (handled by runtime, but define schema for reference)
CREATE TABLE IF NOT EXISTS _migrations (
  name       TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);
