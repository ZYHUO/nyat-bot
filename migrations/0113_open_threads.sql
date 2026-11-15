-- Open threads: things the bot said it would come back to.
--
-- Distinct from `scratchpad` (Redis, 30-minute working memory) and from
-- `dm_pending_lines` (DM-only outbound queue). This is the cross-day kind: the
-- bot promised something, or a topic was left explicitly unfinished, and it
-- should be able to bring it up tomorrow the way a person does — "对了，昨天
-- 你说那个…".
--
-- Deliberately narrow: only EXPLICIT commitments get written here. A general
-- "remember what we talked about" store would produce the awkward recall that
-- makes a bot feel like a bot.

CREATE TABLE IF NOT EXISTS open_threads (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id      INTEGER NOT NULL,
  -- Who the thread is with; 0 when it is about the room rather than a person.
  uid          INTEGER NOT NULL DEFAULT 0,
  -- What the bot owes or is waiting on, in its own words (short).
  note         TEXT NOT NULL,
  -- 'promised' = the bot said it would do/find out something.
  -- 'waiting'  = the bot is waiting on the user ("等你的文件").
  kind         TEXT NOT NULL,
  -- When the bot said it would get back to it, if it said (epoch sec).
  due_at       INTEGER,
  created_at   INTEGER NOT NULL,
  -- Set once the thread has been raised again or explicitly dropped.
  closed_at    INTEGER,
  -- How many times it has been surfaced; stops it nagging.
  surfaced     INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_open_threads_chat_open
  ON open_threads (chat_id, closed_at, due_at);
