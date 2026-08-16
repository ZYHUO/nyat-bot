-- 0061: 多智能体安全共享 (AGI Level 5 Phase 5)
-- Mind Viruses 警示: 一个 bot 学到的坏经验会传染另一个。
-- 共享门控: 只有 verified=1(已证实)的经验可跨 bot; 其余仅本 bot 用。

ALTER TABLE experience_entries ADD COLUMN origin_bot TEXT NOT NULL DEFAULT 'self';
CREATE INDEX IF NOT EXISTS idx_experience_origin_verified ON experience_entries(origin_bot, verified);
