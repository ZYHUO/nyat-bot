-- 0059: 长期任务语义 (AGI Level 5 Phase 3)
-- VibeLifeBench 理念: goal 升级为「跨周持续关注 + 主动发现世界悄悄变化」。

ALTER TABLE goals ADD COLUMN long_term INTEGER NOT NULL DEFAULT 0;
ALTER TABLE goals ADD COLUMN silent_change_detected INTEGER NOT NULL DEFAULT 0;
ALTER TABLE goals ADD COLUMN check_count INTEGER NOT NULL DEFAULT 0;
