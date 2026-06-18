-- 功能 B(好感度主动私聊)数据层。三表一次建好,分期 B1/B2/B3 逐步使用。

-- B1/B2:用户是否曾私聊过 bot。TG 硬限制:bot 只能给「曾给 bot 发过消息」的人
-- 主动发 DM,否则 Forbidden。睡前/起床悄悄话只发给 dm_users 里的人。
CREATE TABLE IF NOT EXISTS dm_users (
  uid         INTEGER PRIMARY KEY,
  first_dm_at INTEGER NOT NULL,
  last_dm_at  INTEGER NOT NULL
);

-- B2:攒话队列。对高好感用户「想说但没机会说」的话先存着,等对方私聊时渐进 flush。
CREATE TABLE IF NOT EXISTS dm_pending_lines (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  uid        INTEGER NOT NULL,
  intent     TEXT NOT NULL,             -- 想说的话(意图,非成品文案)
  context    TEXT NOT NULL DEFAULT '',  -- 缘起上下文(哪个群/哪句话)
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  flushed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_dm_pending_uid ON dm_pending_lines(uid, flushed_at, expires_at);

-- B3:@催pm 状态机(高好感但从没 DM → 群里@说 pm,≤3次递增间隔,默认关灰度)。
CREATE TABLE IF NOT EXISTS pm_nudge_state (
  uid             INTEGER PRIMARY KEY,
  state           TEXT NOT NULL DEFAULT 'none',  -- none | nudging | dm_open | exhausted
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_nudge_at   INTEGER,
  next_nudge_at   INTEGER,
  primary_chat_id INTEGER,
  resentment      REAL NOT NULL DEFAULT 0,        -- 0..1,只微调语气不外化冷落
  exhausted_until INTEGER,
  updated_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
