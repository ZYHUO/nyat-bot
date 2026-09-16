-- ============================================
-- Timed mute: add mute_expires_at column
-- NULL = permanent, unix timestamp = auto-expire
-- ============================================

ALTER TABLE user_preferences ADD COLUMN mute_expires_at INTEGER;
