-- Approval gate for learned expressions (self-learning, automated — no human WebUI).
-- Learned situation→style patterns were injected into the system prompt directly,
-- so a few bad samples could drift the bot's voice. Now new patterns start 'pending'
-- and an automated quality gate must approve them (on-persona, coherent, not toxic)
-- before they inject. Existing learned patterns are grandfathered to 'approved'.
-- Ported (gate mechanism only) from NickCharlie/astrbot_plugin_self_learning.
ALTER TABLE expressions ADD COLUMN status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE expressions ADD COLUMN confidence REAL NOT NULL DEFAULT 0.5;
UPDATE expressions SET status = 'approved';
CREATE INDEX IF NOT EXISTS idx_expressions_status ON expressions(chat_id, status, count DESC);
