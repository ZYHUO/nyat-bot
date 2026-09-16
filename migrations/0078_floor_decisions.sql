-- 0078: floor/addressee 决策证据 (AGI H1.1)
-- 每条群消息的 addressee 三档 verdict 落库: to_me/to_other/ambient/not_me。
-- 纯观测表,删了只丢统计,不影响主流程。每周抽样 50 条人工标算 to_me precision。
CREATE TABLE IF NOT EXISTS floor_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  verdict TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_floor_chat_time ON floor_decisions(chat_id, created_at);
