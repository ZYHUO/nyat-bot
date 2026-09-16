-- Memory importance metadata (sidecar to Chroma) for importance scoring + forgetting.
-- Chroma grew unbounded (every message embedded forever) with no notion of which
-- memories matter. This tracks, per Chroma entry, when it was created, how often it
-- was actually recalled into a reply, and when last recalled — so the "dream" cron
-- can forget old never-recalled memories, and retrieval can boost oft-recalled ones.
-- Ported from LeoYeAI/openclaw-auto-dream (importance = base × recency × reference).
CREATE TABLE IF NOT EXISTS memory_meta (
    chroma_id    TEXT    PRIMARY KEY,     -- "{chatId}_{messageId}"
    chat_id      INTEGER NOT NULL,
    created_at   INTEGER NOT NULL,
    last_ref_at  INTEGER,
    ref_count    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_memory_meta_chat ON memory_meta(chat_id, created_at);
CREATE INDEX IF NOT EXISTS idx_memory_meta_forget ON memory_meta(chat_id, ref_count, created_at);
