-- 0117: goals 的「待关闭」观察期。
--
-- Why: GOAL_EVIDENCE_GATE_ENABLED 要求 task.assessment='verified' 才能把 goal 关成 achieved。
-- 但 goal 检查任务多半不发消息（no_update / 只记内部判断），没有 Echo 可观测，assessment 恒为
-- unverified。结果：模型说"已完成"，goal 却永远 active（goal 35、42 都是），占着
-- GOAL_MAX_ACTIVE，新承诺进不来（日志里 54 次 `goal rejected: max active reached`）。
--
-- 不能放宽证据门（那等于让模型自己给自己判完成）。改成两段式：
--   模型声称完成 → pending_close（不占活跃名额）→ 观察期满后由 host 看世界的反应：
--   这段时间里有人又提起这个话题 → 回 active；没有 → achieved（last_evidence='silence'）。
--
-- Additive and idempotent: status 是自由文本列，无需改约束；老行 close_requested_at 为 NULL。

ALTER TABLE goals ADD COLUMN close_requested_at INTEGER;
ALTER TABLE goals ADD COLUMN silence_closures INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_goals_pending_close
  ON goals(status, close_requested_at);
