-- 0112: let self_replies carry the observed outcome of each bot message.
--
-- Why: the bot already records what it said (self_replies, 2640 rows) and already
-- distils abstract daily rules from reply outcomes (reply_reflections). What was
-- missing is the concrete immediate view — "in this chat I spoke 4 times in the
-- last 45 min: 2 landed, 1 ignored, 1 corrected".
--
-- That blind spot caused a documented incident (src/pipeline/heart/heart.ts:66-76):
--   "bot 说一句 → 后续消息命中跟进规则 → 自动回 → 永远'刚说过话'
--    → 69 次回复里只有 12 次经过心流"
-- Giving the model the facts lets it hold back on its own, without a new rule.
--
-- Additive and idempotent: existing rows keep outcome='unknown'.

ALTER TABLE self_replies ADD COLUMN bot_message_id INTEGER;
ALTER TABLE self_replies ADD COLUMN outcome TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE self_replies ADD COLUMN outcome_at INTEGER;

-- The lookup is always "this chat, newest N rows", and outcome closing matches on
-- the bot's message id within a chat.
CREATE INDEX IF NOT EXISTS idx_self_replies_chat_ts
  ON self_replies(chat_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_self_replies_chat_botmsg
  ON self_replies(chat_id, bot_message_id);
