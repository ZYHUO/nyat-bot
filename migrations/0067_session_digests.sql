-- ============================================
-- Session Digest 持久化 (CGM consciousness-memory 借鉴, DIGEST_PERSIST_ENABLED 默认关)
--
-- 现状:Meta session 的 [SESSION_DIGEST] 只进内存 global-state(40 条) + Redis list
-- (40 条),重启即只剩 Redis 那 40 条;Subagent endTask 摘要只做 callback,不可检索。
-- 本表把所有 digest 永久落盘,构成全局叙事流(CGM: "dispatched X" / "task Y finished"
-- 也都是 digest),后续 session 从这里做 delta 注入,FTS 供未来的 memory 工具检索。
--
-- FTS 采用 0051 的「独立表 + 写入侧 Intl.Segmenter 预分词」模式,而不是 0054 的
-- 外部内容表 + 触发器:digest 以中文为主,unicode61 对未分词的连续汉字只会整段成
-- token,双字词(篮球/拉面)永远查不到 —— 0051 头注释有生产实测记录。seg 列存
-- segment() 的输出,写入与查询共用同一分词器(src/meta/session-digest.ts)。
-- digest 只增不删,无需 delete 同步路径。
--
-- created_at 为 unix 秒(与 episodes/tasks 等表的 nowSec() 约定一致)。
-- ============================================

CREATE TABLE IF NOT EXISTS session_digests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- 'meta' | 'subagent' | 'dispatch'
  kind TEXT NOT NULL,
  source_chat_id INTEGER,
  task_id TEXT,
  text TEXT NOT NULL,
  -- JSON 数组字符串,可空
  tags TEXT,
  importance REAL NOT NULL DEFAULT 0.5,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_session_digests_created ON session_digests(created_at);
CREATE INDEX IF NOT EXISTS idx_session_digests_kind ON session_digests(kind, created_at);
CREATE INDEX IF NOT EXISTS idx_session_digests_chat ON session_digests(source_chat_id, created_at);

CREATE VIRTUAL TABLE IF NOT EXISTS session_digests_fts USING fts5(
  digest_id UNINDEXED,
  seg,
  tokenize='unicode61'
);
