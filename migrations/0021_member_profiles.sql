-- Member profiles (群友小档案) — private notes about other users
CREATE TABLE IF NOT EXISTS member_profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id INTEGER NOT NULL,
    target_id INTEGER NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    tags TEXT,                    -- JSON array of tag strings
    notify_on_speak INTEGER NOT NULL DEFAULT 0,  -- 1 = notify when target speaks
    last_notified_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_member_profiles_unique ON member_profiles(owner_id, target_id);
CREATE INDEX IF NOT EXISTS idx_member_profiles_target ON member_profiles(target_id);
