-- 2026-09-22 round 5：needs_admin 允许 NULL（= "不知道"）。
--
-- 病因：0038 里 needs_admin 是 NOT NULL DEFAULT 1，而 bot-command-store.ts 的
-- insert 分支写 `p.needsAdmin === false ? 0 : 1`——LLM 没表态（null/漏字段）时存 1。
-- 1 在 whyNotInvocable 里是**永久拒绝**，于是 30 个 profile 因为一次含糊的
-- LLM 回答永远不能借力（subagent 审计实测：18 learning + 12 blocked），
-- 其中 16 个 blocked 行的 needs_admin 其实是 0。
--
-- 一次没看懂就永久判刑，比漏放行危险得多：漏放行只是少用一次，
-- 误判是这条命令永远学不来。
--
-- SQLite 不能直接改列约束，按标准套路重建表。数据原样搬迁（1→1、0→0），
-- 不动任何现存行——只是给"不知道"留出位置。
CREATE TABLE bot_command_profiles_new (
  bot_username       TEXT NOT NULL,
  command_name       TEXT NOT NULL,
  usage_syntax       TEXT NOT NULL DEFAULT '',
  use_scenario       TEXT NOT NULL DEFAULT '',
  needs_reply        INTEGER NOT NULL DEFAULT 0,
  needs_admin        INTEGER DEFAULT 1,   -- 1=需要 0=不需要 NULL=还不知道（不参与拒绝判据）
  output_type        TEXT NOT NULL DEFAULT 'unknown',
  peer_accepts_bot   INTEGER,
  confidence         REAL NOT NULL DEFAULT 0.3,
  observation_count  INTEGER NOT NULL DEFAULT 0,
  status             TEXT NOT NULL DEFAULT 'learning',
  last_learned_ts    INTEGER NOT NULL DEFAULT 0,
  created_at         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bot_username, command_name)
);
INSERT INTO bot_command_profiles_new
  SELECT bot_username, command_name, usage_syntax, use_scenario, needs_reply,
         needs_admin, output_type, peer_accepts_bot, confidence,
         observation_count, status, last_learned_ts, created_at
  FROM bot_command_profiles;
DROP TABLE bot_command_profiles;
ALTER TABLE bot_command_profiles_new RENAME TO bot_command_profiles;
