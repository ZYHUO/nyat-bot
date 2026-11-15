CREATE TABLE IF NOT EXISTS onebot_notice_receipts (
  event_key TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  chat_id INTEGER NOT NULL,
  user_id TEXT,
  message_id INTEGER,
  occurred_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_onebot_notice_receipts_age ON onebot_notice_receipts(received_at);

CREATE TABLE IF NOT EXISTS onebot_group_member_state (
  account_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  present INTEGER,
  presence_at INTEGER NOT NULL DEFAULT 0,
  role TEXT CHECK (role IN ('admin', 'member')),
  role_at INTEGER NOT NULL DEFAULT 0,
  muted_until INTEGER,
  mute_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, group_id, user_id)
);

CREATE TABLE IF NOT EXISTS onebot_friend_state (
  account_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, user_id)
);

-- No recalled content is copied here. Retain the tombstone across restarts.
CREATE TABLE IF NOT EXISTS onebot_message_recalls (
  chat_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  account_id TEXT NOT NULL,
  recalled_at INTEGER NOT NULL,
  PRIMARY KEY (chat_id, message_id)
);
