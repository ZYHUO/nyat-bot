-- 0088: Bot Predictions — 行动后果预测与 prediction error (CSR Phase D)
-- 每次 bot 交付消息时记录对用户反应的预测（先验或模型自报），
-- 用户 reaction/reply 情绪到达后回填 actual_sentiment 并计算 error。
-- 这是"行动 → 预测 → 观察 → 修正"闭环的数据地基；不在此层做任何智能决策。
CREATE TABLE IF NOT EXISTS bot_predictions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  task_id TEXT,
  message_id INTEGER,
  source TEXT NOT NULL DEFAULT 'system_prior' CHECK (source IN ('system_prior','model')),
  prediction TEXT,
  predicted_sentiment REAL NOT NULL DEFAULT 0.5,
  actual_sentiment REAL,
  prediction_error REAL,
  feedback_kind TEXT,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_predictions_message ON bot_predictions(chat_id, message_id);
CREATE INDEX IF NOT EXISTS idx_predictions_unresolved ON bot_predictions(resolved_at);
CREATE INDEX IF NOT EXISTS idx_predictions_task ON bot_predictions(task_id);
