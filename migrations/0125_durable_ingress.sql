-- Authoritative input/decision payloads. A started attempt is never blindly replayed.
CREATE TABLE IF NOT EXISTS ingress_inbox (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  lane TEXT NOT NULL CHECK(lane IN ('telegram', 'onebot', 'qq_heart')),
  chat_id INTEGER NOT NULL,
  platform TEXT NOT NULL,
  account_id TEXT NOT NULL,
  identity_json TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending', 'processing', 'handler_returned', 'settled', 'unknown', 'held')),
  received_at_ms INTEGER NOT NULL,
  processed_at_ms INTEGER,
  updated_at_ms INTEGER NOT NULL,
  owner TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  lease_until_ms INTEGER,
  reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_ingress_pending ON ingress_inbox(lane, state, sequence);
CREATE INDEX IF NOT EXISTS idx_ingress_leases ON ingress_inbox(state, lease_until_ms);
CREATE INDEX IF NOT EXISTS idx_ingress_chat ON ingress_inbox(chat_id, lane, state, sequence);
