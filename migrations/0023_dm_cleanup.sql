-- DM enhancement cleanup
-- 1. fate_history: enforce one draw per user per day
-- 2. anonymous_notes: index for cron scans by published_at
-- 3. user_preferences: partial unique index for default_group upsert

-- Remove duplicate fate draws before enforcing uniqueness (keep latest per user/day)
DELETE FROM fate_history
WHERE id NOT IN (
    SELECT MAX(id) FROM fate_history GROUP BY user_id, drawn_at
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_fate_user_date_unique
    ON fate_history(user_id, drawn_at);

CREATE INDEX IF NOT EXISTS idx_anonymous_notes_published_at
    ON anonymous_notes(published_at, status);

-- One default-group preference per user (stored under chat_id=0 sentinel)
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_prefs_default_group_unique
    ON user_preferences(chat_id, uid, pref_key)
    WHERE pref_key = 'default_group';
