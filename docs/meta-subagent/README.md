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
DREAM_JOURNAL_CRON=5 16 * * *          # UTC；北京 00:05
DREAM_JOURNAL_CHAT_ID=3954993432       # → -1003954993432 频道
DREAM_JOURNAL_DM=false
DREAM_JOURNAL_USAGE=reply
```

重启：`npm run build && sudo systemctl restart xxb-ts`

## 数据流

1. Ingress：`isMetaSubagentChat` 为真时，先做 feature 分流再 Attention：
   - `/` 与 NL「签到/排行」→ **legacy pipeline**（要 reply 注入）
   - NL 图鉴/心愿/游戏/追踪、猜数字进行中、DM relay/树洞/选群、consent → **Meta ingress intercept**（`src/meta/ingress-intercepts.ts`）
   - mute 用户 → 丢弃；其余写入 Redis ctx + Attention（L0=直接/@ /DM，L2=旁观）
2. `startMetaLoop`（与 ingress 同进程）每 `META_TICK_MS` flush Attention → `runMetaSession`。
3. Meta LLM 写 JS，调用 `dispatch.taskToGroup`；L0 未调度会 gap-fill 自动 dispatch。
4. Subagent CodeAct：完整人格层 + host API；`sendText` 写回 ctx/Qdrant；群聊软截断。
5. 完成后 callback 回 Attention（L1_CALLBACK）。
6. 日记 cron 用**真实聊天记录**作证据（Meta digests 仅参考）。

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
