-- 0050: 补齐热路径缺失的索引。
--
-- 四张表的复合主键/已有索引的**最左列**都不是实际查询条件用的那一列,所以走全表扫描。
-- better-sqlite3 是同步 API,全表扫是直接压在唯一的 JS 线程上的,最坏的调用点是 N+1:
-- dm-proactive.ts 对 listDmEverUids(90天) 的每个 uid 各扫一次 chat_relationships,
-- pm-nudge.ts 在 LIMIT 80 的循环里最多扫 80 次 —— 整个进程(ingress + worker + pipeline)
-- 在这期间完全停摆。

-- chat_relationships: PRIMARY KEY (chat_id, uid),最左列是 chat_id,
-- 而 user-affinity.getAggregatedAffinity 查的是 `WHERE uid = ?` → SCAN。
-- 同时修掉 pm-nudge 的 `GROUP BY uid` + `ORDER BY`(双临时 B-tree)与 relationship-summarize。
CREATE INDEX IF NOT EXISTS idx_chat_relationships_uid
  ON chat_relationships(uid);

-- user_profiles: 已有 idx_user_profiles_chat(chat_id) 与 PK (chat_id, uid),两者最左列都是
-- chat_id。getAggregatedUserTag 查 `WHERE uid = ? AND sender_tag IS NOT NULL
-- ORDER BY updated_at DESC LIMIT 1` —— LIMIT 1 不能剪枝(要先排序),必须全扫 + 临时排序。
CREATE INDEX IF NOT EXISTS idx_user_profiles_uid
  ON user_profiles(uid, updated_at DESC);

-- sticker_items: 唯一非 PK 索引 idx_sticker_resident(resident, analysis_status) 的最左列是
-- resident,而 getReadyStickersByIntent 不约束 resident → SCAN。该表随 bot 在所有群见过的
-- 每一个不同贴纸增长且从不清理,扫完之后还要对每行 × 每个 intent × 每个 emotion tag 跑
-- 归一化 Levenshtein(同步 JS),而这条查询在用户可见的回复延迟路径上。
CREATE INDEX IF NOT EXISTS idx_sticker_items_ready
  ON sticker_items(analysis_status, user_score DESC);

-- social_edges: 查询计划本身干净(SEARCH USING idx_social_edges_chat),但行数趋向
-- O(群成员²) 且每次回复全量取回后在 JS 里做时间衰减 + 过滤 + 排序。衰减只会**减小**
-- weight,所以 buildSocialInjection 侧加 `AND weight >= 2` 是可证明安全的前置过滤;
-- 这个索引让它能提前停,不必读完整张表。
CREATE INDEX IF NOT EXISTS idx_social_edges_chat_weight
  ON social_edges(chat_id, weight DESC);
