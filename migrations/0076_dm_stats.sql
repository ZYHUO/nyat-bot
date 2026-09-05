-- 0076: 反向阀门接线 (AGI Level 6 Phase 14.1)
-- dm_daily_stats: 私聊按天×用户聚合(风险打分的输入)。bookkeeping 同步写,
-- valve 读取最近 14 天算分。纯增量表,删了只丢风险输入,不影响主流程。
CREATE TABLE IF NOT EXISTS dm_daily_stats (
  date TEXT NOT NULL,
  uid INTEGER NOT NULL,
  msgs INTEGER NOT NULL DEFAULT 0,
  night_msgs INTEGER NOT NULL DEFAULT 0,
  emotion_msgs INTEGER NOT NULL DEFAULT 0,
  session_min INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (date, uid)
);
CREATE INDEX IF NOT EXISTS idx_dm_daily_stats_uid ON dm_daily_stats(uid, date);
