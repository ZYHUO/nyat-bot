-- ============================================
-- Phase 3: Sticker Knowledge tables
-- ============================================

-- Sticker items (main knowledge store)
CREATE TABLE IF NOT EXISTS sticker_items (
  file_unique_id TEXT PRIMARY KEY,
  latest_file_id TEXT,
  set_name TEXT,
  emoji TEXT,
  sticker_format TEXT NOT NULL DEFAULT 'unknown',
  usage_count INTEGER NOT NULL DEFAULT 0,
  sample_count INTEGER NOT NULL DEFAULT 0,
  first_seen_at INTEGER,
  last_seen_at INTEGER,
  analysis_status TEXT NOT NULL DEFAULT 'pending',
  analysis_reason TEXT,
  analysis_updated_at INTEGER,
  asset_status TEXT NOT NULL DEFAULT 'missing',
  raw_asset_path TEXT,
  preview_asset_path TEXT,
  -- AI analysis results (JSON text)
  emotion_tags TEXT,       -- JSON array: ["cute", "sleepy"]
  mood_map TEXT,           -- JSON object: {"happy": 0.8, "playful": 0.3}
  persona_fit INTEGER,     -- 0 = false, 1 = true, NULL = unknown
  description TEXT
);

-- Sticker usage samples
CREATE TABLE IF NOT EXISTS sticker_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_unique_id TEXT NOT NULL REFERENCES sticker_items(file_unique_id),
  chat_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  date INTEGER NOT NULL,
  from_user_id INTEGER,
  username TEXT,
  reply_to_message_id INTEGER,
  reply_target_text TEXT,
  context_before TEXT       -- JSON array of recent context messages
);

CREATE INDEX IF NOT EXISTS idx_sticker_samples_fuid ON sticker_samples(file_unique_id);
CREATE INDEX IF NOT EXISTS idx_sticker_samples_chat ON sticker_samples(file_unique_id, chat_id);
