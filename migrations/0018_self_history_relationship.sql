-- Migration 0018: self-narrative + relationship narrative
-- Stage F: bot remembers what it said to whom + cumulative relationship per (chat, user).

CREATE TABLE IF NOT EXISTS self_replies (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id         INTEGER NOT NULL,
  trigger_uid     INTEGER NOT NULL,
  trigger_msg_id  INTEGER,
  reply_text      TEXT    NOT NULL,
  ts              INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_self_replies_chat_uid_ts
  ON self_replies(chat_id, trigger_uid, ts DESC);

CREATE TABLE IF NOT EXISTS chat_relationships (
  chat_id              INTEGER NOT NULL,
  uid                  INTEGER NOT NULL,
  affinity             REAL    NOT NULL DEFAULT 0,
  interaction_count    INTEGER NOT NULL DEFAULT 0,
  last_interaction_at  INTEGER NOT NULL,
  last_summary         TEXT    NOT NULL DEFAULT '',
  updated_at           INTEGER NOT NULL,
  PRIMARY KEY (chat_id, uid)
);
