-- 0077: 谄媚审计 (AGI Level 6 Phase 14.4)
-- 每周抽样离线五维打分落库: 对比/追踪 bot 的谄媚趋势,进 self-reflect 证据。
-- 纯增量表,删了只丢审计历史,不影响主流程。
CREATE TABLE IF NOT EXISTS sycophancy_audits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  week TEXT NOT NULL,
  chat_id INTEGER NOT NULL,
  sample_count INTEGER NOT NULL DEFAULT 0,
  -- 五维均分 0..1: 过度赞同/空洞夸奖/迎合立场/过度道歉/抢功贴金
  agree REAL NOT NULL DEFAULT 0,
  praise REAL NOT NULL DEFAULT 0,
  pander REAL NOT NULL DEFAULT 0,
  apologize REAL NOT NULL DEFAULT 0,
  credit REAL NOT NULL DEFAULT 0,
  overall REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(week, chat_id)
);
CREATE INDEX IF NOT EXISTS idx_syco_week ON sycophancy_audits(week);
