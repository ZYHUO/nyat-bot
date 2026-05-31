-- Inter-user social graph: tracks member↔member interactions (reply chains, @s)
-- per group, so the bot can comment on group dynamics ("你俩又聊到一块了喵").
-- Distinct from the bot↔user affinity/mood/reputation tables. Canonical uid_a < uid_b.
CREATE TABLE IF NOT EXISTS social_edges (
  chat_id INTEGER NOT NULL,
  uid_a   INTEGER NOT NULL,
  uid_b   INTEGER NOT NULL,
  name_a  TEXT    NOT NULL DEFAULT '',
  name_b  TEXT    NOT NULL DEFAULT '',
  weight  REAL    NOT NULL DEFAULT 1,
  last_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (chat_id, uid_a, uid_b)
);
CREATE INDEX IF NOT EXISTS idx_social_edges_chat ON social_edges(chat_id);
