-- ============================================
-- H4.2: taste 转发闭环归因 (reaction→reward 回流到源话题)
-- taste_forwards 加落点列：转发在目标群的新 messageId。
-- 目标群有人给转发点 reaction → 反查源群+源 messageId → reward 回源话题。
-- 纯 ADD COLUMN，旧行 to_* 为 NULL（查不到落点=不归因，零行为变化）。
-- ============================================

ALTER TABLE taste_forwards ADD COLUMN to_chat_id INTEGER;
ALTER TABLE taste_forwards ADD COLUMN to_message_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_taste_fwd_landing ON taste_forwards(to_chat_id, to_message_id);
