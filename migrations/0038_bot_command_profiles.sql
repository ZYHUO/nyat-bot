-- 其他 bot 的命令档案:长期观察学出"如何/何时用 + 约束",成熟后才允许代发。
-- 一行 = 某 bot 的某条命令。confidence/observation_count 随观察累积,达阈值才解锁代发。
CREATE TABLE IF NOT EXISTS bot_command_profiles (
  bot_username       TEXT NOT NULL,           -- 目标 bot(不含 @)
  command_name       TEXT NOT NULL,           -- /stock 形式(含前导斜杠,小写)
  usage_syntax       TEXT NOT NULL DEFAULT '',-- 怎么用:参数格式,如 "/geo <IP>"
  use_scenario       TEXT NOT NULL DEFAULT '',-- 什么场景用:一句话
  needs_reply        INTEGER NOT NULL DEFAULT 0,  -- 是否必须 reply 某条消息才生效(0/1)
  needs_admin        INTEGER NOT NULL DEFAULT 1,  -- 是否需要管理员权限(保守默认 1=需要→禁,学到不需要才翻 0)
  output_type        TEXT NOT NULL DEFAULT 'unknown', -- text|url|callback|media|mixed|unknown:回执形态(可达性闸)
  peer_accepts_bot   INTEGER,                 -- 目标 bot 是否响应 bot 发的命令:NULL=未知,1=是(需@指向),0=否
  confidence         REAL NOT NULL DEFAULT 0.3,
  observation_count  INTEGER NOT NULL DEFAULT 0,
  status             TEXT NOT NULL DEFAULT 'learning', -- learning|ready|blocked(blocked=安全门硬禁类)
  last_learned_ts    INTEGER NOT NULL DEFAULT 0,
  created_at         INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (bot_username, command_name)
);

CREATE INDEX IF NOT EXISTS idx_bot_cmd_ready
  ON bot_command_profiles (status, confidence);
