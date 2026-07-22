# Meta + Subagent（在 nyatbot / xxb-ts 内）

> CyberGroupmate 同构编排：**Attention → Meta(CodeAct) → dispatch → Subagent(CodeAct) → callback**  
> 主机是 **xxb-ts**，不是 fork CGM。

## Flags（默认全关，行为与改造前一致）

```bash
META_SUBAGENT_ENABLED=true
META_SUBAGENT_CHAT_IDS=          # 空=全群启用
META_TICK_MS=5000
META_USAGE=judge
CODEACT_USAGE=reply
CODEACT_MAX_TURNS=6
CONTEXT_ENGINE_ENABLED=true
CODEACT_BANNED_WORDS=是吧,对吧,作为一个AI

DREAM_JOURNAL_ENABLED=true
DREAM_JOURNAL_DIR=./data/dream-journal
DREAM_JOURNAL_CRON=0 23 * * *,0 15 * * *   # UTC：北京 07:00 早 / 23:00 睡前；逗号多段
DREAM_JOURNAL_HOOK_SLEEP=true              # 作息起床/入睡边沿也试写（模型可 SKIP）
DREAM_JOURNAL_CHAT_ID=3954993432       # → -1003954993432 频道
DREAM_JOURNAL_DM=false
DREAM_JOURNAL_USAGE=reply
```

日记：模型返回 `WRITE`/`SKIP`；一天可多段 append；不设条数上限。优先早上/睡前（cron 保底写 + sleep 边沿 Attention 提醒 Meta）。  
Meta 可用 `journal.tryWrite({slot})` / `journal.recent()`；`diary:*` Attention 禁止为此 dispatch。

重启：`npm run build && sudo systemctl restart xxb-ts`

## 数据流

1. Ingress：`isMetaSubagentChat` 为真时，先做 feature 分流再 Attention：
   - `/` 与 NL「签到/排行」→ **legacy pipeline**（要 reply 注入）
   - NL 图鉴/心愿/游戏/追踪、猜数字进行中、DM relay/树洞/选群、consent → **Meta ingress intercept**（`src/meta/ingress-intercepts.ts`）
   - mute / 睡眠门 → 丢弃或入 sleep-queue；其余写入 Redis ctx
   - Attention 写入 Redis list `xxb:meta:attention`（ingress↔worker 可拆）
   - L0=直接/@/DM → 直通 Attention→Meta
   - 非 L0 旁观：`HEART_ENABLED` 时先跑 Heart（reply→升 L1 进 Meta；pass/wait→沉默/等待）；**Heart 即 gate，放行后不再跑 Meta timing**。Heart 关则 L2 硬丢
   - L0/direct 仍可走 Meta timing（实际短路 allow）；媒体 `processMedia` 异步不堵 grammY
2. Worker 上 `startMetaLoop` 每 `META_TICK_MS` 从 Redis flush Attention + callbacks → `runMetaSession`。
3. Meta LLM 写 JS，调用 `dispatch.taskToGroup`；L0 未调度会 gap-fill 自动 dispatch。
4. Subagent CodeAct：完整人格层 + host API（含 `web.search`、`meta.request`）；`sendText` 写回 ctx/Qdrant；CJK 友好软截断。
5. 完成后 callback 进 Redis `xxb:meta:callbacks`。Subagent 也可 `meta.request({action})` 投 Attention `subagent_request:*`（如 `journal.write`），下一 tick Meta 硬处理或再编排。
6. 日记 cron 用**真实聊天记录**作证据；起床补回对 Meta 群重投 Attention。用户直说写日记 / Subagent 升级写日记 → Meta `journal.tryWrite`（可 force）。
7. Side effects：topic-watch、on_speak 捎话、DM affinity / 唤醒 poke。
8. **Timing gate**：Meta 在 Attention 前跑同一套 `runTimingGate`（L0/direct 短路；L1 可 wait/no_action；L2 旁观不进 Attention）。wait 到期经 `wait_resume` 再投 Attention；CodeAct `sendText` 写回 `recordBotReply` 续窗。
9. **CodeAct 耐久**：`xxb-codeact` BullMQ 队列 + 每 chat Redis busy 锁；全局 `CODEACT_CONCURRENCY`（默认 4）并行不同群。Attention/callback 用 Lua 原子 claim。

```bash
CODEACT_WEB_SEARCH_ENABLED=true   # Subagent web.search；复用 pipeline executeSearch
```

## Context Engine

`src/context-engine/`：`static|delta|ephemeral|volatile` 组装 + Manifest（`cacheHitRatio` 打日志）。  
缓存命中率取决于上游模型/中转是否支持 prompt cache；架构上前缀已稳定。

## 日记

`src/cron/dream-journal.ts` → `data/dream-journal/YYYY-MM-DD.md`（上海日历日）。  
与 `memory-dream`（遗忘）无关。

## 人设方向

`prompts/meta/background-dreaming.md` 注入 Meta/Subagent static 段。

## 记忆

不另起库：Subagent `memory.search` → 现有 Qdrant `searchMemory`；跨人召回沿用已落地的 person-centric / visibility flags。  
导出审计：`npx tsx scripts/migrate-xxb-memory-export.ts`

## 灰度建议

1. 设 `META_SUBAGENT_CHAT_IDS` 为一个测试群。  
2. 开 `META_SUBAGENT_ENABLED` +（可选）`DREAM_JOURNAL_ENABLED`。  
3. 看 `logs/app.log`：`Meta attention ingested` / `Meta session start` / `CodeAct task`。  
4. 主群切流前保持其它群走原 pipeline。

## 第一期明确不搬

turn-actor / timing-gate FSM / Heart 三件套、gacha、Mini App Admin —— 节奏由 Attention + Meta + post-task 语义承担。
