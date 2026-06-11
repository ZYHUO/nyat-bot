-- 0036: drop the orphaned `messages` table.
--
-- Context moved to Redis lists (xxb:ctx:{chatId}) + Qdrant long ago; the
-- last SQLite writer disappeared with it. The sole remaining reader
-- (fate.ts 最近发言) was repointed to user_profiles.pending_messages in
-- the previous commit. A zero-writer table that looks like a source of
-- truth is worse than no table — it silently feeds empty results.
DROP INDEX IF EXISTS idx_messages_chat_ts;
DROP TABLE IF EXISTS messages;
