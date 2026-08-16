-- 0065: Task 对象架构 (AGI Level 6 Phase 13)
-- 补 harness 的「执行 + 状态」:主动的、有状态的、能跨天存活的任务对象。
-- 两个循环分开:回复循环(低延迟说话) vs 任务循环(BullMQ worker 无延迟压力)。
--
-- 安全: 持久化 agent 是质变(输出写进记忆/触发工具/修改组件 → 注入变慢性中毒),
--       创建权限收紧:只有被 @ 的直接请求能建,群里随便一句话不能。

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- 归属:谁建的、在哪个群
  owner_uid INTEGER NOT NULL,
  chat_id INTEGER NOT NULL,
  -- 任务目标(自然语言)与类型
  goal TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'research',   -- research | monitor | summarize
  -- 状态机
  state TEXT NOT NULL DEFAULT 'pending',   -- pending | running | blocked | waiting_user | done | cancelled
  -- 台账:事实台账(已做步骤+结果) + 进度台账(还差什么/卡在哪), JSON 数组
  ledger TEXT NOT NULL DEFAULT '[]',
  progress TEXT NOT NULL DEFAULT '[]',
  -- 唤醒:定时(timestamp)/事件(trigger 描述) —— 连续性物理实现
  next_wake INTEGER,
  wake_trigger TEXT,
  -- 结果:完成后主动发回的消息
  result TEXT,
  -- 多轮搜索状态
  search_round INTEGER NOT NULL DEFAULT 0,
  max_rounds INTEGER NOT NULL DEFAULT 6,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_state_wake ON tasks(state, next_wake);
CREATE INDEX IF NOT EXISTS idx_tasks_owner ON tasks(owner_uid, chat_id);
