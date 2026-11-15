CREATE TABLE IF NOT EXISTS onebot_requests (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('friend', 'group')),
  sub_type TEXT NOT NULL CHECK (sub_type IN ('friend', 'add', 'invite')),
  user_id TEXT NOT NULL,
  group_id TEXT,
  flag_hash TEXT NOT NULL,
  flag TEXT NOT NULL,
  comment TEXT NOT NULL,
  event_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'approved', 'rejected', 'expired', 'unknown', 'failed')),
  attempt_id TEXT,
  decision INTEGER CHECK (decision IN (0, 1)),
  decided_by TEXT,
  updated_at INTEGER NOT NULL,
  result_code TEXT,
  UNIQUE (account_id, kind, sub_type, flag_hash)
);
CREATE INDEX IF NOT EXISTS idx_onebot_requests_queue
  ON onebot_requests (account_id, status, received_at DESC);

-- A duplicate owner message must not retry even a definitely-unsent attempt.
CREATE TABLE IF NOT EXISTS onebot_request_commands (
  account_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  request_id TEXT NOT NULL REFERENCES onebot_requests(id),
  attempt_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, message_id)
);
