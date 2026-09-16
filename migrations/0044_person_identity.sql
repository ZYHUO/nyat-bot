-- Cross-group person identity (借鉴 CyberGroupmate 的两层人物模型)。
-- per-(chat,uid) 的 user_profiles 是「群内画像」;这张表是「跨群身份」——
-- 把一个人在多个群的画像收敛成一份整体印象,让 bot 在 B 群也认得在 A 群熟的人,
-- 也给跨群好感 DM 一个一致的「画像/印象」来源。
-- 刷新是廉价确定性的:取好感最高的群(primary)的画像作为跨群印象,无需 LLM。
CREATE TABLE IF NOT EXISTS person_identity (
    uid             INTEGER PRIMARY KEY,
    impression      TEXT,                       -- 跨群整体印象(取自 primary 群画像)
    primary_chat_id INTEGER,                    -- 好感最高的群
    chat_count      INTEGER NOT NULL DEFAULT 0, -- 出现在几个群
    updated_at      INTEGER NOT NULL DEFAULT (unixepoch())
);
