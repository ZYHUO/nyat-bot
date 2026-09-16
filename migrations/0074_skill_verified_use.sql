ALTER TABLE skills ADD COLUMN verified_use_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE skills ADD COLUMN last_verified_use_at INTEGER;
CREATE INDEX IF NOT EXISTS idx_skills_verified_use ON skills(archived, verified_use_count DESC);
