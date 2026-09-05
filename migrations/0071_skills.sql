-- 0071: 自我技能沉淀 (AGI 自我 skill 系统)
-- 每 6h 从 episodes + experience_entries 蒸馏「小 skill」,
-- 每周合并去重成「大 skill」,小 skill 归档防爆。
-- skill 是结构化能力单元(触发条件/步骤/坑),区别于碎片化经验条目。

CREATE TABLE IF NOT EXISTS skills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,                 -- 技能名(短,如「画图」「找人」)
  tier TEXT NOT NULL DEFAULT 'small', -- small | big
  trigger_when TEXT NOT NULL,         -- 触发条件(何时用这个 skill)
  steps TEXT NOT NULL,                -- 步骤/做法(JSON 数组或纯文本)
  pitfalls TEXT,                      -- 坑/注意事项
  summary TEXT,                       -- 一句话摘要
  tags TEXT NOT NULL DEFAULT '[]',    -- JSON 数组
  source_skill_ids TEXT,              -- 合并来源(大 skill 记录被合并的小 skill id)
  archived INTEGER NOT NULL DEFAULT 0,-- 1=已归档(被大 skill 回收,不再注入)
  use_count INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_skills_tier ON skills(tier, archived, use_count DESC);
CREATE INDEX IF NOT EXISTS idx_skills_created ON skills(created_at DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS skills_fts USING fts5(
  name, trigger_when, steps, pitfalls, summary, tags,
  content='skills', content_rowid='id'
);
CREATE TRIGGER IF NOT EXISTS skills_ai AFTER INSERT ON skills BEGIN
  INSERT INTO skills_fts(rowid, name, trigger_when, steps, pitfalls, summary, tags)
  VALUES (new.id, new.name, new.trigger_when, new.steps, new.pitfalls, new.summary, new.tags);
END;
CREATE TRIGGER IF NOT EXISTS skills_ad AFTER DELETE ON skills BEGIN
  INSERT INTO skills_fts(skills_fts, rowid, name, trigger_when, steps, pitfalls, summary, tags)
  VALUES('delete', old.id, old.name, old.trigger_when, old.steps, old.pitfalls, old.summary, old.tags);
END;
-- 注意: 与 experience_entries 同款 —— content 字段永不 UPDATE(只有 use_count/
-- last_used_at/archived 会变),故无 AFTER UPDATE 触发器。若未来要 UPDATE
-- name/trigger_when/steps 等,必须先补 skills_au 触发器,否则 FTS 索引不同步。
