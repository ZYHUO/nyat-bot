-- 机制2:把 person_identity(PK uid,0044)从「搬 primary 群画像摘要」升级为
-- 真正的**全局 PersonProfile**——跨上下文(群+DM)提炼的稳定认知。借鉴
-- CyberGroupmate 的两层人物模型:全局层(本表新列)存跨上下文稳定认知,
-- 每群层沿用 user_profiles/user_profile_sections(per-(chat,uid),不动)。
--
-- 全局列由机制5 的 LLM 合并 cron(profile-merge)产出;impression 保留作兜底/回退。
-- 新列均可空,ADD COLUMN 幂等(SQLite 不支持 IF NOT EXISTS on column,但迁移只应用一次)。
ALTER TABLE person_identity ADD COLUMN traits TEXT;             -- JSON string[]:跨上下文稳定性格/行为特点
ALTER TABLE person_identity ADD COLUMN interests TEXT;          -- JSON string[]:跨上下文长期兴趣
ALTER TABLE person_identity ADD COLUMN comm_style TEXT;         -- 跨上下文一致的沟通风格(文本)
ALTER TABLE person_identity ADD COLUMN relation_to_bot TEXT;    -- 与 bot 的总体关系描述(文本)
ALTER TABLE person_identity ADD COLUMN stable_patterns TEXT;    -- JSON string[]:稳定互动模式
ALTER TABLE person_identity ADD COLUMN source_context_ids TEXT; -- JSON number[]:本全局认知来自哪些 chatId(含 DM)
ALTER TABLE person_identity ADD COLUMN confidence REAL NOT NULL DEFAULT 0; -- 合并置信度 0-1
ALTER TABLE person_identity ADD COLUMN last_merged_at INTEGER;  -- 上次 LLM 合并时刻(unixepoch;NULL=从未合并)
