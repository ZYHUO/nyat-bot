-- reply_max quota tracking (per-user per-day, 3 max)
CREATE TABLE IF NOT EXISTS reply_max_quota (
  uid   INTEGER NOT NULL,
  date  TEXT    NOT NULL,  -- YYYY-MM-DD UTC
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (uid, date)
);
