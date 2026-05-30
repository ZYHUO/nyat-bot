-- Image description cache, keyed by Telegram file_unique_id (stable across links).
-- Regular images were re-downloaded + re-VLM'd on every occurrence; a reposted/
-- forwarded meme now reuses its description, saving cost+latency and preserving
-- the image's meaning after the original file link expires.
CREATE TABLE IF NOT EXISTS image_descriptions (
    file_unique_id TEXT PRIMARY KEY,
    description    TEXT    NOT NULL,
    created_at     INTEGER NOT NULL DEFAULT (unixepoch())
);
