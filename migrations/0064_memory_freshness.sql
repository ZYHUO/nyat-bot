-- 0064: 记忆陈旧检测 (AGI Level 5 Phase 12, L6)
-- 防「群友换工作/分手了还在自信引用旧事实」+ 记忆投毒风险。
-- 保守: 先检测后降权, 不自动删。

ALTER TABLE user_profiles ADD COLUMN last_confirmed_at INTEGER;
ALTER TABLE person_identity ADD COLUMN last_confirmed_at INTEGER;
ALTER TABLE user_profiles ADD COLUMN stale INTEGER NOT NULL DEFAULT 0;
ALTER TABLE person_identity ADD COLUMN stale INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_user_profiles_stale ON user_profiles(stale);
CREATE INDEX IF NOT EXISTS idx_person_identity_stale ON person_identity(stale);
