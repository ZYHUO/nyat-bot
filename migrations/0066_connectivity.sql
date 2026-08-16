-- 0066: 反向阀门 L7 (AGI Level 6 Phase 14)
-- 连接率埋点: bot 消息后 5 分钟窗口内的人-人对话轮数。
-- 新核心指标(替代 engagement): 把话题抛出去让群活起来的 bot > 吸走注意力的 bot。

CREATE TABLE IF NOT EXISTS connectivity_windows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  bot_mid INTEGER NOT NULL,
  bot_username TEXT NOT NULL DEFAULT '',
  bot_ts INTEGER NOT NULL,
  window_end INTEGER NOT NULL,
  human_rounds INTEGER NOT NULL DEFAULT 0,
  calculated INTEGER NOT NULL DEFAULT 0,
  UNIQUE(chat_id, bot_mid)
);

CREATE INDEX IF NOT EXISTS idx_connectivity_due ON connectivity_windows(calculated, window_end);
