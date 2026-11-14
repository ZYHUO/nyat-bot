-- Storage keys share the existing global ordinal sequence with QQ identities.
-- The reserved message-kind key is NOT a platform message and has no routing alias.
CREATE TABLE IF NOT EXISTS context_storage_scopes (
  scope_key TEXT PRIMARY KEY,
  allocation_id INTEGER NOT NULL UNIQUE REFERENCES platform_identity_allocations(id) ON DELETE RESTRICT,
  platform TEXT NOT NULL CHECK (platform IN ('telegram', 'qq')),
  account_id TEXT NOT NULL,
  chat_id INTEGER NOT NULL,
  conversation_kind TEXT NOT NULL CHECK (conversation_kind IN ('private', 'group')),
  thread_id INTEGER NOT NULL CHECK (thread_id >= 0),
  created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER)),
  UNIQUE (platform, account_id, chat_id, conversation_kind, thread_id)
);
