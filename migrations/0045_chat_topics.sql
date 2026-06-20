-- Topic lifecycle registry (借鉴 CyberGroupmate 的 Recording Pipeline / Topic Registry)。
-- 每个群维护一份「当前在聊什么」的话题表,带生命周期:active(在聊)→ cooling(渐冷)
-- → dead(过去式)→ 清理。用于:让 bot 知道此刻话题、感知话题切换、回捞渐冷话题
-- (「对了之前聊的X」),也可喂主动度(有热话题的群更值得开口)。
CREATE TABLE IF NOT EXISTS chat_topics (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id     INTEGER NOT NULL,
    label       TEXT    NOT NULL,                  -- 话题短标签(4-12 字)
    state       TEXT    NOT NULL DEFAULT 'active', -- active | cooling | dead
    msg_count   INTEGER NOT NULL DEFAULT 1,        -- 被观察到的次数(热度/置信代理)
    first_seen  INTEGER NOT NULL DEFAULT (unixepoch()),
    last_active INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_topics_unique ON chat_topics(chat_id, label);
CREATE INDEX IF NOT EXISTS idx_chat_topics_live ON chat_topics(chat_id, state, last_active DESC);
