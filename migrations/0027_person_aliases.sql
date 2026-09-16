-- Durable per-person aliases / 外号 captured from group chat.
-- A nickname is a compact, long-lived fact about a person; storing it here (and
-- injecting it into the reply prompt) lets the bot "remember" 外号 long after the
-- declaring message scrolls out of the recent window — without bloating context.
CREATE TABLE IF NOT EXISTS person_aliases (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id       INTEGER NOT NULL,
    subject_name  TEXT    NOT NULL,            -- the person, by the surface name people use
    alias         TEXT    NOT NULL,            -- their 外号 / 别名
    source_uid    INTEGER NOT NULL DEFAULT 0,  -- who stated it (best effort)
    count         INTEGER NOT NULL DEFAULT 1,  -- times re-stated (confidence/recency proxy)
    created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at    INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_person_aliases_unique ON person_aliases(chat_id, subject_name, alias);
CREATE INDEX IF NOT EXISTS idx_person_aliases_chat ON person_aliases(chat_id, count DESC, updated_at DESC);
