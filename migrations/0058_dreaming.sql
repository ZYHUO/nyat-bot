-- 0058: Dreaming 整合 (AGI Level 5 Phase 2)
-- MindMemOS dreaming: 每周语义合并冗余/冲突经验。
-- FTS 外部内容表需要 AFTER UPDATE 触发器(content/tags 会被 dreaming 更新)。
-- WHEN 条件:只在 content/tags 实际变化时才重建 FTS(否则每次 use_count/
-- verified 更新都会触发 delete+insert churn —— reviewer 建议)。

ALTER TABLE experience_entries ADD COLUMN updated_at INTEGER;

CREATE TRIGGER IF NOT EXISTS experience_au AFTER UPDATE ON experience_entries
WHEN old.content IS NOT new.content OR old.tags IS NOT new.tags
BEGIN
  INSERT INTO experience_fts(experience_fts, rowid, content, tags) VALUES('delete', old.id, old.content, old.tags);
  INSERT INTO experience_fts(rowid, content, tags) VALUES (new.id, new.content, new.tags);
END;
