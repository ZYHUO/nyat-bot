-- ============================================
-- #3 用户即时反馈 (AGI Level 4 P4-C / P3 signal)
-- feedback_events: reaction + reply sentiment
-- goal_subtasks: 目标子树拆解
-- ============================================

-- feedback_events — 收录用户对 bot 消息的即时反应
CREATE TABLE IF NOT EXISTS feedback_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,              -- 'reaction' | 'replier_positive' | 'replier_negative' | 'replier_neutral'
  user_id INTEGER NOT NULL,
  bot_message_id INTEGER,          -- 被反应的 bot 消息 (reaction 时)
  chat_id INTEGER NOT NULL,
  emoji TEXT,                      -- reaction emoji (kind='reaction' 时)
  sentiment REAL NOT NULL DEFAULT 0,  -- [-1, 1]
  raw_text TEXT,                   -- 原始用户消息 (reply 时)
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feedback_user_time
  ON feedback_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_feedback_chat_time
  ON feedback_events(chat_id, created_at DESC);

-- goal_subtasks — 目标子树
CREATE TABLE IF NOT EXISTS goal_subtasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id INTEGER NOT NULL REFERENCES goals(id),
  parent_id INTEGER REFERENCES goal_subtasks(id),
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  result TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_subtask_goal
  ON goal_subtasks(goal_id, status);
CREATE INDEX IF NOT EXISTS idx_subtask_parent
  ON goal_subtasks(parent_id);
