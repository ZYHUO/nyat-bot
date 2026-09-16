-- 记忆保护档 —— 对齐 MaiBot v1.1.0 的「冻结 / 恢复 / 保护 / 永久保留」。
--
-- 现状:遗忘 cron 的条件是 `ref_count = 0 AND created_at < cutoff`。人设级的核心事实
-- (生日、称呼、雷区、约定)如果恰好从没被检索命中过,就和普通闲聊一起被删掉 ——
-- 而这类事实恰恰是"很少被查、但一旦忘了就很致命"的那种。
--
-- protection:
--   0 = 普通,照常参与遗忘
--   1 = 保护,永不被自动遗忘(仍可显式删除)
--   2 = 永久,永不遗忘 + 检索重要度加权
ALTER TABLE memory_meta ADD COLUMN protection INTEGER NOT NULL DEFAULT 0;

-- 遗忘查询会带上 protection 过滤,把它并进既有的复合索引里,避免退化成扫描。
CREATE INDEX IF NOT EXISTS idx_memory_meta_forget_protected
    ON memory_meta(chat_id, protection, ref_count, created_at);
