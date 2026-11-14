-- Durable bridge into the numeric core. Telegram keeps its existing IDs.
-- QQ allocation ordinals become 2^52 + id (negative only for groups).
-- A principal owns both the QQ user and its private-chat alias, preserving the
-- existing core's DM chatId == uid convention without merging platforms/accounts.
CREATE TABLE IF NOT EXISTS platform_identity_allocations (
  id INTEGER PRIMARY KEY AUTOINCREMENT
    CONSTRAINT platform_identity_ordinal_range CHECK (id BETWEEN 1 AND 4503599627370495),
  identity_kind TEXT NOT NULL CHECK (identity_kind IN ('principal', 'group', 'message')),
  identity_key TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER)),
  UNIQUE (identity_kind, identity_key)
);

CREATE TABLE IF NOT EXISTS platform_identity_refs (
  ref_kind TEXT NOT NULL CHECK (ref_kind IN ('conversation', 'user', 'message')),
  ref_key TEXT NOT NULL,
  identity_id INTEGER NOT NULL REFERENCES platform_identity_allocations(id) ON DELETE RESTRICT,
  ref_json TEXT NOT NULL,
  conversation_identity_id INTEGER REFERENCES platform_identity_allocations(id) ON DELETE RESTRICT,
  PRIMARY KEY (ref_kind, ref_key),
  UNIQUE (ref_kind, identity_id),
  CHECK ((ref_kind = 'message' AND conversation_identity_id IS NOT NULL)
    OR (ref_kind <> 'message' AND conversation_identity_id IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_platform_message_conversation
  ON platform_identity_refs(conversation_identity_id, identity_id)
  WHERE ref_kind = 'message';
