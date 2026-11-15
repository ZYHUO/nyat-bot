CREATE TABLE IF NOT EXISTS scheduled_runs (
    task_name TEXT NOT NULL,
    scheduled_at INTEGER NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('scheduled','claimed','started','succeeded','skipped','failed','unknown')),
    owner TEXT,
    lease_until INTEGER,
    retry_safe INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    available_at INTEGER NOT NULL,
    started_at INTEGER,
    finished_at INTEGER,
    reason TEXT,
    PRIMARY KEY(task_name, scheduled_at)
);
CREATE INDEX IF NOT EXISTS idx_scheduled_runs_pending ON scheduled_runs(task_name,state,available_at);
CREATE TABLE IF NOT EXISTS scheduled_task_progress (
    task_name TEXT PRIMARY KEY,
    last_completed_at INTEGER NOT NULL
);
