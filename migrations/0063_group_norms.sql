-- 0063: 群体风格画像 (AGI Level 5 Phase 9, L3)
-- LoSoNA 理念: 每个群都有自己的隐性规范(玩梗/正经/短句/不聊政治)。
-- 观察 N 条消息 → LLM 推断该群规则 → 注入 reply prompt。
-- DM 不建 norms; norms 只描述风格,不存用户隐私内容。

CREATE TABLE IF NOT EXISTS group_norms (
  chat_id INTEGER PRIMARY KEY,
  norms TEXT NOT NULL,           -- JSON 数组, ≤5 条
  sample_count INTEGER NOT NULL DEFAULT 0,
  last_updated_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
