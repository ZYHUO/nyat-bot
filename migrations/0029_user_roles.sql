-- Behavioral roles / 群友角色 — periodic LLM-assigned archetype per active user
-- (龙王 / 技术专家 / 夜猫子 / 表情包军火库 / 潜水员 …). Injected as a compact hint
-- so the bot relates to people by their group persona. Ported from
-- astrbot_plugin_qq_group_daily_analysis (role-tagging + windowed analysis).
CREATE TABLE IF NOT EXISTS user_roles (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id     INTEGER NOT NULL,
    uid         INTEGER NOT NULL,
    role_name   TEXT    NOT NULL,
    rationale   TEXT    NOT NULL DEFAULT '',
    mbti        TEXT    NOT NULL DEFAULT '',
    assigned_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_roles_unique ON user_roles(chat_id, uid);
CREATE INDEX IF NOT EXISTS idx_user_roles_chat ON user_roles(chat_id, updated_at DESC);
