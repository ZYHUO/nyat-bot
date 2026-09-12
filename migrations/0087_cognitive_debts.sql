-- 0087: Cognitive Debt — 未完成认知（承诺/不确定/纠正/未竟任务/矛盾/过时信念）
-- 目标：让 bot 记得"自己尚未解决什么"，而不仅是"过去发生过什么"。
-- 每条债务必须可追踪来源、可偿还、可过期；禁止把模型口头声称当已解决。
CREATE TABLE IF NOT EXISTS cognitive_debts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  owner_uid INTEGER,
  task_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('promise','uncertainty','correction','unfinished_task','conflict','stale_belief')),
  statement TEXT NOT NULL,
  source_event_ids TEXT NOT NULL DEFAULT '[]',
  priority INTEGER NOT NULL DEFAULT 5,
  confidence REAL NOT NULL DEFAULT 0.5,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','superseded','expired')),
  resolution TEXT,
  superseded_by INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  next_check_at INTEGER,
  expires_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_debts_chat_status ON cognitive_debts(chat_id, status, priority DESC, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_debts_owner ON cognitive_debts(owner_uid, status);
CREATE INDEX IF NOT EXISTS idx_debts_next_check ON cognitive_debts(status, next_check_at);
