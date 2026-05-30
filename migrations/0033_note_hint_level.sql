-- Durable guess-hint reveal state for anonymous notes.
-- Previously hint-drip idempotency relied solely on an ephemeral Redis key
-- (xxb:note:hint:{id}:{level}); if Redis evicted/flushed/restarted while a note
-- was still inside the 24h guess window, the same hint re-posted to the group.
-- Track the highest revealed level in SQLite so the guard survives Redis loss.
ALTER TABLE anonymous_notes ADD COLUMN hint_level INTEGER NOT NULL DEFAULT 1;

-- Backfill: existing published notes have already dripped via the old path —
-- mark them fully revealed so this migration doesn't trigger a fresh drip.
UPDATE anonymous_notes SET hint_level = 3 WHERE status = 'published';
