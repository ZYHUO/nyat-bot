-- Anonymous notes (匿名小纸条)
CREATE TABLE IF NOT EXISTS anonymous_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id INTEGER NOT NULL,
    target_id INTEGER,            -- nullable = whole group
    group_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    hints TEXT,                   -- JSON array of hint strings, nullable
    guessable INTEGER NOT NULL DEFAULT 1,  -- 1 = allow guessing, 0 = never reveal
    guesses TEXT,                 -- JSON array of {uid, guessed_uid, correct, ts}, nullable
    status TEXT NOT NULL DEFAULT 'pending', -- pending / published / closed / expired
    published_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_anonymous_notes_group ON anonymous_notes(group_id, status);
CREATE INDEX IF NOT EXISTS idx_anonymous_notes_sender ON anonymous_notes(sender_id);
