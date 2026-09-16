-- ============================================
-- Mute dedup: add UNIQUE constraint on (chat_id, uid, pref_key)
-- for mute entries, and add mute_level column
-- ============================================

-- Add mute_level column (0 = proactive only, 1 = full silence)
ALTER TABLE user_preferences ADD COLUMN mute_level INTEGER NOT NULL DEFAULT 0;

-- Remove duplicate mute rows, keep only the latest per (chat_id, uid)
DELETE FROM user_preferences
WHERE pref_key = 'mute'
  AND id NOT IN (
    SELECT MAX(id) FROM user_preferences
    WHERE pref_key = 'mute'
    GROUP BY chat_id, uid
  );

-- Create unique index so future mute upserts don't duplicate
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_prefs_mute_unique
  ON user_preferences(chat_id, uid, pref_key)
  WHERE pref_key = 'mute';
