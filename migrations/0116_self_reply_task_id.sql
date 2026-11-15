-- 0116: let self_replies remember which CodeAct task sent each bot message.
--
-- Why: task_evidence.assessment is 'unverified' for every group-chat task (7038 of 7039 rows),
-- because group replies have no caller contract. The host nevertheless observes the one fact
-- that matters — did anyone pick the message up (self_replies.outcome: replied / mentioned /
-- reacted / ignored / corrected, settled by tracking/outcome.ts). Without a task_id on the row
-- that observation cannot be traced back to the task, so skill/experience verification had no
-- independent signal and the whole experience -> skill chain starved.
--
-- Additive and idempotent: existing rows keep task_id NULL (never backfilled — we do not
-- invent a link we did not observe).

ALTER TABLE self_replies ADD COLUMN task_id TEXT;

CREATE INDEX IF NOT EXISTS idx_self_replies_task
  ON self_replies(task_id);

-- Which skills a task had injected into its prompt. Outcomes settle minutes after the task
-- ends (tracking/outcome.ts waits up to 10 min), by which time the in-memory
-- injectedSkillIds is gone; verified-use credit must be attributable to the skills that were
-- actually in the prompt, so persist the link at injection time.
CREATE TABLE IF NOT EXISTS task_skill_injections (
  task_id TEXT NOT NULL,
  skill_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, skill_id)
);
CREATE INDEX IF NOT EXISTS idx_task_skill_injections_created
  ON task_skill_injections(created_at);
