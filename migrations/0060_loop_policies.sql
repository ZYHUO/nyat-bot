-- 0060: Loop 策略资产化 (AGI Level 5 Phase 4)
-- OpenLoopEvolve 理念: 任务循环策略(验证/重试/停止规则)做成可进化的资产。
-- 简单版: 计数进化, 不做完整版本谱系。

CREATE TABLE IF NOT EXISTS loop_policies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,               -- 'verify_before_deliver' | 'retry_on_429' | ...
  description TEXT,
  rule TEXT NOT NULL,               -- 策略内容(注入 executor prompt 的文本)
  enabled INTEGER DEFAULT 1,
  trigger_count INTEGER DEFAULT 0,  -- 被注入触发的次数
  success_count INTEGER DEFAULT 0,  -- 触发后任务成功次数
  failure_count INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_loop_policies_enabled ON loop_policies(enabled, success_count DESC);
