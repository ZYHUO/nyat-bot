ALTER TABLE goals ADD COLUMN verified_achievements INTEGER NOT NULL DEFAULT 0;
ALTER TABLE goals ADD COLUMN unverified_completions INTEGER NOT NULL DEFAULT 0;
ALTER TABLE goals ADD COLUMN last_evidence TEXT NOT NULL DEFAULT 'unverified';
CREATE INDEX IF NOT EXISTS idx_goals_evidence ON goals(status, last_evidence);
