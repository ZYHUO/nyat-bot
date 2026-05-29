-- Migration: DM enhancements (P0: relay queue + scheduled messages)
-- 1. relay_queue — enhanced relay (捎话) with trigger modes
-- 2. scheduled_messages — timed reminders (定时提醒)
-- 3. group_features — per-group feature toggles

-- ============================================================
-- 1. relay_queue: 支持 immediate / on_speak / scheduled 三种触发模式
-- ============================================================
CREATE TABLE IF NOT EXISTS relay_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id INTEGER NOT NULL,
    target_id INTEGER NOT NULL,
    group_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    trigger_mode TEXT NOT NULL DEFAULT 'on_speak',  -- immediate / on_speak / scheduled
    scheduled_at INTEGER,                           -- nullable, for scheduled trigger
    expires_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',          -- pending / delivered / expired / cancelled
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    delivered_at INTEGER
);

-- Index: on_speak 模式下快速查找目标用户在群内的待投递消息
CREATE INDEX IF NOT EXISTS idx_relay_queue_target_group_status
    ON relay_queue (target_id, group_id, status);

-- Index: 发送者查看/取消自己的捎话
CREATE INDEX IF NOT EXISTS idx_relay_queue_sender_status
    ON relay_queue (sender_id, status);

-- ============================================================
-- 2. scheduled_messages: 定时提醒，支持一次性和 cron 循环
-- ============================================================
CREATE TABLE IF NOT EXISTS scheduled_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id INTEGER NOT NULL,
    group_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    next_run_at INTEGER NOT NULL,
    cron_expr TEXT,                                 -- nullable, for recurring
    timezone TEXT DEFAULT 'Asia/Shanghai',
    active INTEGER NOT NULL DEFAULT 1,
    last_run_at INTEGER,
    run_count INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Index: 调度器扫描即将到期的提醒
CREATE INDEX IF NOT EXISTS idx_scheduled_messages_scan
    ON scheduled_messages (next_run_at, active);

-- Index: 用户查看自己的提醒列表
CREATE INDEX IF NOT EXISTS idx_scheduled_messages_owner
    ON scheduled_messages (owner_id);

-- ============================================================
-- 3. group_features: 按群组开关功能特性
-- ============================================================
CREATE TABLE IF NOT EXISTS group_features (
    group_id INTEGER NOT NULL,
    feature TEXT NOT NULL,   -- relay_queue / scheduled_messages / anonymous_note / member_profile / treehole / fate
    enabled INTEGER NOT NULL DEFAULT 1,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE(group_id, feature)
);
