CREATE TABLE IF NOT EXISTS self_model_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  note TEXT NOT NULL,
  evidence TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_self_notes_created ON self_model_notes(created_at DESC);
