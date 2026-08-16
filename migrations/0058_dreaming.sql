-- 0058: Dreaming 整合 (AGI Level 5 Phase 2)
-- MindMemOS dreaming: 每周语义合并冗余/冲突经验。
-- FTS 外部内容表需要 AFTER UPDATE 触发器(content/tags 会被 dreaming 更新)。

ALTER TABLE experience_entries ADD COLUMN updated_at INTEGER;

CREATE TRIGGER IF NOT EXISTS experience_au AFTER UPDATE ON experience_entries BEGIN
  INSERT INTO experience_fts(experience_fts, rowid, content, tags) VALUES('delete', old.id, old.content, old.tags);
  INSERT INTO experience_fts(rowid, content, tags) VALUES (new.id, new.content, new.tags);
END;
