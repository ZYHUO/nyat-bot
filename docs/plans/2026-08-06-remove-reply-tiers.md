# 删除 reply_pro / reply_max 分层（AGI 无分层化）

**目标**：judge 只输出 `REPLY` / `IGNORE` / `REJECT`，不再有 pro/max 预算分层。所有回复走同一条 `reply` 链。

## 背景

reply tier 是"按消息复杂度分配模型预算"的人工分层（normal=短回复/pro=深度/max=最高推理）。与 AGI 理念冲突：模型自己决定回复质量，不该由 judge 预先分级。quota 机制（max 3/day）是分层的价格护栏，分层删了 quota 也无意义。

## 任务

### 1. Judge 动作枚举收窄（src/pipeline/judge/micro.ts）
- `VALID_ACTIONS`：删 `REPLY_PRO`、`REPLY_MAX`
- `RawJudgeAction` 类型同步
- `normalizeJudgeAction`：删 L40/L48 两个 if 分支（REPLY_PRO→REPLY+tier=pro、REPLY_MAX→REPLY+tier=max 的映射）
- JSON 提取正则 L96 + 关键词 fallback L117：删两个动作
- `parseReplyTier` / `VALID_REPLY_TIERS`：删 tier 解析（judge 输出不再读 replyTier 字段）

### 2. Judge prompt（prompts/task/judge.md + prompts/contract/judge-schema.json）
- judge.md L91：删 REPLY_PRO/REPLY_MAX 说明，action 只列三值
- judge.md L93：删 replyTier 字段说明
- judge.md L80-81：删 tier 相关 prose（"与 tier 无关"、"两个独立维度"）
- judge-schema.json：enum 收窄为 `["REPLY","IGNORE","REJECT"]`，删 description 里的 tier 说明，删 replyTier 字段（若有）

### 3. shared/types.ts
- `ReplyTier` 类型、`resolveReplyTier`：删（确认无其他引用后）
- `JudgeResult.replyTier` 字段：删

### 4. reply.ts
- L512：`effectiveReplyTier === 'pro' ? 'reply_pro' : 'reply'` → 恒 `reply`
- L646-647：三态 usage → 恒 `reply`
- 删除 `effectiveReplyTier` 变量及其来源（judge result 的 tier 传递链）

### 5. deliver.ts
- L194-199：删 reply_max quota check 块（quota 耗尽直接 IGNORE 的路径）
- L973：删 "quota consumed after success" 记账
- `emoji_reply_max_length`（L258）：**保留**——这是 emoji 文本长度限制，与 reply_max tier 无关，仅名字巧合

### 6. src/tracking/reply-max-quota.ts
- 整文件删除 + DB 表 `reply_max_quota` 变孤儿表（SQLite 里留着无害，不主动 drop——若删表需迁移逻辑，YAGNI）
- 删除所有 import 点

### 7. src/ai/labels.ts
- L57 注释：usage 列表删 reply_pro / reply_max
- L93-97：`reply_max` 轮换池逻辑（AI_USAGE_REPLY_MAX_LABELS）整段删

### 8. src/ai/router.ts
- L10：`reply_pro: ModelTier.M3_MAIN` 删

### 9. src/env.ts
- L887-890：`addProviderIfMissing('reply_pro', ...)` 块删
- L965-968：backups/usages 里 reply_pro 注册删
- L1118-1122+：`parseReplyMaxLabels`（AI_USAGE_REPLY_MAX_LABELS 解析）整段删
- `AI_MODEL_REPLY_PRO` 字段定义删（若在 zod schema 中）

### 10. src/cron/model-check.ts L23 + src/admin/runtime-config.ts L181
- usageNames 数组删 `'reply_pro'`

### 11. .env（terminal+python3，先备份）
- 删 `AI_USAGE_REPLY_MAX_LABELS=gemini35low,k27code,dsv4flash`
- 检查并删 `AI_MODEL_REPLY_PRO` 相关行（若存在）

### 12. 测试更新
- `tests/unit/ai/labels.test.ts`（13 命中）：删 reply_max 轮换池用例
- `tests/unit/ai/fallback.test.ts`（5）：删 reply_pro/reply_max 路由用例
- `tests/unit/admin/runtime-routing.test.ts`（3）：删 reply_pro usage 用例
- `tests/unit/pipeline/prompt-files.test.ts` L46-49：删 "judge prompt documents REPLY_MAX" 用例（或改为断言**不含** REPLY_MAX）
- `tests/unit/pipeline/planner.test.ts`（2）、`tests/unit/pipeline/reply.test.ts`（1）、`tests/unit/knowledge/sticker/feedback.test.ts`（1）、`tests/unit/ai/provider.test.ts`（1）：逐个点看，删/改对应断言

## 验证
1. `npm run typecheck` 零错
2. `npm run lint` 零警告
3. `npm run test` 全绿
4. `grep -rn 'reply_pro\|reply_max\|REPLY_PRO\|REPLY_MAX' src/ prompts/ tests/` 仅剩 emoji_reply_max_length 与 reply_max_quota 孤儿表注释（若保留说明）
5. build + 重启 + 发消息触发 judge，日志确认 action 无 REPLY_PRO/MAX

## 回滚
- git revert 单 commit
- .env 从 `.env.bak-tier-*` 恢复

## 注意
- micro judge 的 fail-open 兜底：judge 输出旧动作（模型缓存 prompt）时 normalize 应静默归到 REPLY/IGNORE——删掉两个分支后，旧输出会 parse 失败走兜底，需确认兜底行为是安全的（fail-open pass 或 IGNORE，不能崩）
- .env 操作铁律：terminal+python3，先 `cp .env .env.bak-tier-$(date +%s)`
