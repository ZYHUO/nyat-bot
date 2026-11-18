-- Pure Heart evaluation may be recomputed; an attempt that started effects may not.
CREATE TABLE IF NOT EXISTS telegram_heart_candidates (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  scope_key TEXT NOT NULL,
  chat_key TEXT NOT NULL,
  chat_id INTEGER NOT NULL,
  account_id TEXT NOT NULL,
  thread_id INTEGER NOT NULL,
  received_at_ms INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','evaluating','settled','unknown','held')),
  attempts INTEGER NOT NULL DEFAULT 0,
  owner TEXT,
  reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_telegram_heart_pending ON telegram_heart_candidates(state,sequence);
CREATE INDEX IF NOT EXISTS idx_telegram_heart_scope ON telegram_heart_candidates(scope_key,state,sequence);
CREATE INDEX IF NOT EXISTS idx_telegram_heart_chat ON telegram_heart_candidates(chat_key,state);
CREATE TABLE IF NOT EXISTS telegram_heart_claims (
  chat_key TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL,
  owner TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  lease_until_ms INTEGER NOT NULL DEFAULT 0,
  invalidated INTEGER NOT NULL DEFAULT 0,
  effects_started INTEGER NOT NULL DEFAULT 0,
  cancel_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_telegram_heart_active ON telegram_heart_claims(lease_until_ms) WHERE owner IS NOT NULL;
-- A WAIT worker can reserve the next passive turn without retaining a second copy of the source.
CREATE TABLE IF NOT EXISTS telegram_heart_wait_reservations (
  chat_key TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL,
  token TEXT NOT NULL,
  lease_until_ms INTEGER NOT NULL,
  fresh_turn_until_ms INTEGER NOT NULL
);
