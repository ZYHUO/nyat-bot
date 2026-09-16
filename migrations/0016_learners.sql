CREATE TABLE IF NOT EXISTS expressions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id     INTEGER NOT NULL,
  situation   TEXT    NOT NULL,
  style       TEXT    NOT NULL,
  count       INTEGER NOT NULL DEFAULT 1,
  source_msg_id INTEGER,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  UNIQUE(chat_id, situation, style)
);
CREATE INDEX IF NOT EXISTS idx_expressions_chat ON expressions(chat_id, count DESC);

CREATE TABLE IF NOT EXISTS jargons (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id     INTEGER NOT NULL,
  content     TEXT    NOT NULL,
  raw_samples TEXT    NOT NULL DEFAULT '[]',
  meaning     TEXT    NOT NULL DEFAULT '',
  count       INTEGER NOT NULL DEFAULT 1,
  status      TEXT    NOT NULL DEFAULT 'pending',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  UNIQUE(chat_id, content)
);
CREATE INDEX IF NOT EXISTS idx_jargons_chat ON jargons(chat_id, count DESC);
CREATE INDEX IF NOT EXISTS idx_jargons_chat_content ON jargons(chat_id, content);

CREATE TABLE IF NOT EXISTS learner_scan_state (
  chat_id      INTEGER PRIMARY KEY,
  last_msg_id  INTEGER NOT NULL DEFAULT 0,
  last_run_at  INTEGER NOT NULL DEFAULT 0
);
