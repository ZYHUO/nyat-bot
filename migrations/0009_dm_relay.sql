-- ============================================
-- DM Relay: consent, log, bans
-- ============================================

-- Target user opt-in for receiving relayed messages
CREATE TABLE IF NOT EXISTS relay_consent (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_chat_id INTEGER NOT NULL,
  target_uid INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  consent_message_id INTEGER,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_relay_consent_unique
  ON relay_consent(group_chat_id, target_uid);

-- Audit trail + dedup for relayed messages
CREATE TABLE IF NOT EXISTS relay_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_uid INTEGER NOT NULL,
  target_uid INTEGER NOT NULL,
  group_chat_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  sent_message_id INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_relay_log_target
  ON relay_log(target_uid, group_chat_id, created_at);
CREATE INDEX IF NOT EXISTS idx_relay_log_sender
  ON relay_log(sender_uid, created_at);

-- Relay ban list (persisted; spam counter lives in Redis)
CREATE TABLE IF NOT EXISTS relay_bans (
  uid INTEGER PRIMARY KEY,
  reason TEXT,
  banned_at INTEGER NOT NULL DEFAULT (unixepoch())
);
