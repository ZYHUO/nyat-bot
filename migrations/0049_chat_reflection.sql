-- 深度反思(A):每群一份"近况摘要"——bot 更懂这个群最近在聊什么/发生了什么,
-- 注入回复的 [本群近况] 块。由 deep-reflection cron 用大窗口历史 LLM 提炼,滚动更新。
CREATE TABLE IF NOT EXISTS chat_reflection (
    chat_id     INTEGER PRIMARY KEY,
    digest      TEXT    NOT NULL DEFAULT '',
    msg_count   INTEGER NOT NULL DEFAULT 0,   -- 上次反思覆盖到的消息数(增量判定)
    updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
