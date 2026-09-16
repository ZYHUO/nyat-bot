-- 0062: 轻量对象中心世界状态 (AGI Level 5 Phase 6)
-- 面向对象世界模型(文本版): 任务/聊天里出现的实体(person/project/topic/place)
-- 持续维护属性, 供 goal check 等任务开工前注入上下文。

CREATE TABLE IF NOT EXISTS world_entities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,            -- person | project | topic | place
  properties TEXT,               -- JSON {key: value}
  source_chat_id INTEGER,
  last_updated_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_world_entities_name_kind ON world_entities(name, kind);
