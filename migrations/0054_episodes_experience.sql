CREATE TABLE IF NOT EXISTS episodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  chat_id INTEGER NOT NULL,
  goal TEXT NOT NULL,
  outcome TEXT NOT NULL,
  summary TEXT NOT NULL,
  lessons TEXT,
  tags TEXT,
  turns INTEGER DEFAULT 0,
  segments INTEGER DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_episodes_chat ON episodes(chat_id, created_at DESC);

CREATE TABLE IF NOT EXISTS experience_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  tags TEXT NOT NULL,
  source_episode_id INTEGER,
  use_count INTEGER DEFAULT 0,
  last_used_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS experience_fts USING fts5(content, tags, content='experience_entries', content_rowid='id');
CREATE TRIGGER IF NOT EXISTS experience_ai AFTER INSERT ON experience_entries BEGIN
  INSERT INTO experience_fts(rowid, content, tags) VALUES (new.id, new.content, new.tags);
END;
CREATE TRIGGER IF NOT EXISTS experience_ad AFTER DELETE ON experience_entries BEGIN
  INSERT INTO experience_fts(experience_fts, rowid, content, tags) VALUES('delete', old.id, old.content, old.tags);
END;
