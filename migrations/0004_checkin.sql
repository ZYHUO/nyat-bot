-- ============================================
-- Checkin (签到) system
-- ============================================

CREATE TABLE IF NOT EXISTS checkins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  uid INTEGER NOT NULL,
  username TEXT NOT NULL DEFAULT '',
  full_name TEXT NOT NULL DEFAULT '',
  checkin_date TEXT NOT NULL,  -- YYYY-MM-DD in Asia/Shanghai
  streak INTEGER NOT NULL DEFAULT 1,
  total_checkins INTEGER NOT NULL DEFAULT 1,
  reward_coins INTEGER NOT NULL DEFAULT 0,
  reward_exp INTEGER NOT NULL DEFAULT 0,
  lucky_number INTEGER NOT NULL DEFAULT 0,
  fortune TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(chat_id, uid, checkin_date)
);

CREATE INDEX IF NOT EXISTS idx_checkins_chat_date ON checkins(chat_id, checkin_date DESC);
CREATE INDEX IF NOT EXISTS idx_checkins_user ON checkins(chat_id, uid, checkin_date DESC);
