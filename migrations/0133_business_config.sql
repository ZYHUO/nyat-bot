-- Append-only business configuration revisions; one SQLite authority owns writes.
CREATE TABLE IF NOT EXISTS business_config_revisions (
  source_platform TEXT NOT NULL CHECK (source_platform IN ('telegram', 'qq')),
  source_account_id TEXT NOT NULL,
  source_chat_id INTEGER NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  controller_platform TEXT NOT NULL CHECK (controller_platform IN ('telegram', 'qq')),
  controller_account_id TEXT NOT NULL,
  controller_chat_id INTEGER NOT NULL,
  actor_uid INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('patch', 'rollback')),
  before_json TEXT NOT NULL,
  after_json TEXT NOT NULL,
  rollback_revision INTEGER,
  PRIMARY KEY (source_platform, source_account_id, source_chat_id, revision),
  UNIQUE (controller_platform, controller_account_id, controller_chat_id, message_id)
);
