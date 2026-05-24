-- ============================================
-- User preferences: pinned notes remembered by bot
-- ============================================

CREATE TABLE IF NOT EXISTS user_preferences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  uid INTEGER NOT NULL,
  -- Short key describing the preference (auto-generated or 'note')
  pref_key TEXT NOT NULL DEFAULT 'note',
  -- The content the user wants remembered
  value TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_user_prefs_chat_uid
  ON user_preferences(chat_id, uid);
