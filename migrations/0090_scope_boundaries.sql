-- 0090: persist ownership boundaries for Core beliefs and world entities.
-- Existing ambiguous user profile projections remain legacy until their source
-- row is refreshed; they are never injected into a scoped request.
ALTER TABLE core_beliefs ADD COLUMN scope_key TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE core_beliefs ADD COLUMN visibility TEXT NOT NULL DEFAULT 'global';
ALTER TABLE core_beliefs ADD COLUMN scope_chat_id INTEGER;
ALTER TABLE core_beliefs ADD COLUMN scope_user_id INTEGER;
ALTER TABLE core_beliefs ADD COLUMN scope_task_id TEXT;
CREATE INDEX IF NOT EXISTS idx_beliefs_scope ON core_beliefs(predicate, scope_key, status);

UPDATE core_beliefs
SET scope_key = 'chat:' || source_row_id, visibility = 'chat', scope_chat_id = source_row_id
WHERE source_table = 'group_norms';
UPDATE core_beliefs
SET scope_key = 'user:' || source_row_id, visibility = 'user', scope_user_id = source_row_id
WHERE source_table = 'person_identity';
UPDATE core_beliefs
SET scope_key = CASE WHEN g.chat_id IS NULL THEN 'global' ELSE 'chat:' || g.chat_id END,
    visibility = CASE WHEN g.chat_id IS NULL THEN 'global' ELSE 'chat' END,
    scope_chat_id = g.chat_id
FROM goals AS g
WHERE core_beliefs.source_table = 'goals' AND g.id = core_beliefs.source_row_id;

ALTER TABLE world_entities ADD COLUMN scope_key TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE world_entities ADD COLUMN visibility TEXT NOT NULL DEFAULT 'global';
DROP INDEX IF EXISTS idx_world_entities_name_kind;
UPDATE world_entities
SET scope_key = CASE WHEN source_chat_id IS NULL THEN 'global' ELSE 'chat:' || source_chat_id END,
    visibility = CASE WHEN source_chat_id IS NULL THEN 'global' ELSE 'chat' END;
CREATE UNIQUE INDEX IF NOT EXISTS idx_world_entities_name_kind_scope
  ON world_entities(name, kind, scope_key);
CREATE INDEX IF NOT EXISTS idx_world_entities_scope
  ON world_entities(scope_key, last_updated_at);
