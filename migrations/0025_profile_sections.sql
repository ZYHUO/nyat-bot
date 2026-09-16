-- ============================================
-- Structured multi-section persona profiles
-- One row per (chat_id, uid, section_name); bullets is a JSON array of short strings.
-- Backs the structured user picture while user_profiles.profile_prompt stays for back-compat.
-- ============================================

CREATE TABLE IF NOT EXISTS user_profile_sections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  uid INTEGER NOT NULL,
  -- One of: identity, relationships, stable_facts, interaction_prefs, recent, uncertain, maintenance
  section_name TEXT NOT NULL,
  -- JSON array of short bullet strings
  bullets TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_profile_sections_unique
  ON user_profile_sections(chat_id, uid, section_name);

CREATE INDEX IF NOT EXISTS idx_profile_sections_chat_uid
  ON user_profile_sections(chat_id, uid);
