-- 0037: ts index for reply_outcomes retention (audit #40).
--
-- reply_outcomes is the largest append-only log (one row per bot reply,
-- ~9.4k rows and growing); the new time-window DELETE in runCleanup would
-- full-scan without this. The other pruned tables (relay_log /
-- reputation_log / fate_history / daily_stats / reply_reflections) are
-- orders of magnitude smaller — a daily full scan there is cheaper than
-- carrying extra indexes on every write.
CREATE INDEX IF NOT EXISTS idx_reply_outcomes_ts ON reply_outcomes(ts);
