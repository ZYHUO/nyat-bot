-- ============================================
-- H4: 话题 bandit 分数 (reaction/reply 反馈 → 话题偏好)
-- topic_scores: 每群每话题一条，按 (chat_id, label) 累加 reward
-- ============================================

CREATE TABLE IF NOT EXISTS topic_scores (
  chat_id INTEGER NOT NULL,
  label TEXT NOT NULL,
  pulls INTEGER NOT NULL DEFAULT 0,      -- bot 跟进该话题次数
  reward REAL NOT NULL DEFAULT 0,        -- 累计 reward（reaction sentiment + reply sentiment + quote 追问）
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (chat_id, label)
);
CREATE INDEX IF NOT EXISTS idx_topic_scores_chat ON topic_scores(chat_id);
