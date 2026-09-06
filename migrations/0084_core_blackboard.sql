-- ============================================
-- Phase 0 Task 0.3: 类型化黑板 (Core v2)
-- observation|proposal|authorized_intent|plan|execution_receipt
-- 纯增量表，不碰旧表。
-- ============================================

CREATE TABLE IF NOT EXISTS core_blackboard (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  chat_id INTEGER,
  author TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bb_kind_status ON core_blackboard(kind, status);
CREATE INDEX IF NOT EXISTS idx_bb_chat ON core_blackboard(chat_id, created_at DESC);
