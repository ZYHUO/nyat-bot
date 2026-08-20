-- ============================================
-- 0068: Dreaming 做梦简化版 (CGM background-agent 简化移植)
-- 凌晨 cron (DREAMING_CRON) 把「上次做梦以来」的素材(任务/人/digest/群)
-- 打包派发给一个特权长 CodeAct 任务(主人 DM),让它夜里自主干活。
-- dreaming_runs: 每次做梦的运行台账 ——
--   1) 并发护栏: 有未完结(且未 stale)的 running 行就不再起新 run;
--   2) 上下文窗口起点: 下次 run 从上次 done 的 started_at 开始捞素材。
-- 与 dream-journal(写日记,感受向)互补: dreaming 是行动向。
-- ============================================

CREATE TABLE IF NOT EXISTS dreaming_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at INTEGER NOT NULL,               -- unix 秒
  ended_at INTEGER,                          -- NULL = 未收尾(还在跑或进程死了)
  status TEXT NOT NULL DEFAULT 'running',    -- running | done | failed | skipped
  tasks_reviewed INTEGER NOT NULL DEFAULT 0, -- 本周期纳入做梦素材的 CodeAct 任务数
  summary TEXT                               -- 收尾备注(dispatched: <taskId> / 失败原因)
);

CREATE INDEX IF NOT EXISTS idx_dreaming_runs_status_started
  ON dreaming_runs(status, started_at);
