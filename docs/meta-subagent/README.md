# Meta + Subagent（在 nyatbot / xxb-ts 内）

> CyberGroupmate 同构编排：**Attention → Meta(CodeAct) → dispatch → Subagent(CodeAct) → callback**  
> 主机是 **xxb-ts**，不是 fork CGM。

## Flags（默认全关，行为与改造前一致）

启用前必须通过实际服务用户的 OS 隔离检查，见 [执行隔离边界](./ISOLATION.md)。
实际运行状态以最近一次部署预检为准，不能由下方示例推断已经启用。
下面的历史开关示例不能替代隔离预检；缺失隔离时生成代码不会在宿主进程执行。

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

## Telegram 群聊在 Heart 判断前合并

已有 Meta/Heart 灰度群可单独试用。在接收消息的 authority 和处理 WAIT 的 worker 上配置相同的 bot 账号、激活时间、灰度范围和持久状态。先确认该群的 `META_PENDING_INTENT_ENABLED` 已启用。发送者、话题和输入修订共同决定一个判读结果能否继续派发。配置样例中的群号应替换成实际获准群。

```dotenv
META_TG_GROUP_COALESCE_CHAT_IDS=-1000000000001
META_TG_GROUP_COALESCE_MS=800
META_TG_GROUP_COALESCE_MAX_MS=2400
```

空名单或静默窗为 0 都关闭前置合并。窗口从真实收件时间起算，截止取“最后一条加静默窗”和“第一条加最长窗”的较早者。明确点名、回复 bot、已验证的主人命令和私聊继续走原入口。普通消息在同一账号、群和话题内合成一次 Heart 输入，每条保留发言者、消息 ID 与引用。Heart 选中的多条问题可以合成一条答复。异群、异话题不会共用这次判读的上下文。

迁移 0134 保存候选消息和群的执行租约。迁移 0135 在同一条候选上保存 Heart 选中的等待期限。例如甲问“周几发车”，乙另问“在哪集合”，两人的问题可以同时等待。甲引用自己的问题补上发车日期时，乙的消息 ID、发言人、引用和原截止时间都保留。到期后 Heart 会结合该话题的新上下文判断。若群里已有答案、来源失效，或 Heart 仍想等，本次可以安静结束。

同一作者补充或新消息明确引用某条等待消息时，该来源可以随新批次提前复查一次。再次等待沿用第一次的截止时间。同群同话题的到期来源可合批，单批最多 32 条。来源在待判期间发生修订或取消时会复核自己的发言者状态。到期重评通过后，实际发送仍检查账号、话题版本、时效和当前发送条件。重评只使用当前账号和话题最近 40 条消息核对原文、发言人和引用。若已超出窗口或原文发生变化，会安静跳过该来源，并在 `telegram_heart_wait_source_skipped_total` 按原因计数。启用 NyatDB 时，新写入且完整的 Telegram 群消息可核对原始事件版本。旧行缺少版本、消息超出存储页预算，或正文、引用、媒体被裁剪时，同样跳过。

Heart 已把某条等待消息交给 Attention、Meta 还没接单时，新的群内补充可能令这次判断过时。只有在原作者、消息、引用、修订及回执都能核实的情况下，系统才会把原始来源交回 Heart 重评一次。明确打断、已接单、已有回复或结果未知时会保留发送保护。

接收灰度群消息的进程负责恢复 SQLite 中的候选。重启后可继续等待和恢复未执行副作用的判断。每个评估阶段因故失败或被连续打断最多尝试三次，耗尽后记为 `held`。反应或消息可能已经提交且结果未确认时记为 `unknown`。终态清除候选正文并保留去重记录。群状态须由单一 SQLite authority 协调，分布在不同主机的独立 SQLite 副本各自计数。

同一个 authority 最多同时持有 4 个被动判读席位，同群一次执行一个批次。旧版本已登记的 Redis/BullMQ 等待，以及其他继续使用该传输的路径，仍按每个 chat 一个 WAIT 槽、按代次领取。提前唤醒移回原截止时间。旧 worker 可在同群忙碌时预约复查席位，等待最多 100 秒。共享 WAIT 预约和执行的上限为 2。观测旧任务使用 `meta_wait_recheck_handoffs_total` 和 `meta_wait_recheck_yield_total`。切换版本前排空旧 worker，再运行迁移和新版 authority。回退时同样先停收或排空 SQLite 中已等待的来源。

灰度验证时，同窗统计 `telegram_heart_batch_candidates_total` 和 `telegram_heart_batches_started_total`，两者相除得到每次开始处理的平均输入数，含再次评估的输入。结合 `telegram_heart_model_calls_total` 的 primary、repair、reflect 分别观察逻辑调用；供应商实际 RPM 还受到 SDK 重试、备用路由和对冲影响。若同时启用 NyatOS 的逐消息影子评估，应将它的模型请求单列。比较明确问题的响应时延、批次超时、错误或未知回执及群内不当插话。回退时把静默窗设回 0，先排空或取消在途任务，再变更 pending-intent 或 authority。保留 SQLite 去重记录和未知回执。

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

## 会话来源边界

Attention 在入队、出队和进入 Meta 会话时检查来源；Meta 按会话分别组装提示，
不把 QQ/TG、不同 QQ 账号、群聊或私聊的待办内容合成一个模型上下文。
QQ 内部 ID 必须能反查到当前账号，消息、发送者和引用也必须属于对应会话。
不合法或已撤回的引用副本会移除，合法的同会话正文和引用仍可使用。

回调与 Subagent 请求必须能核验原任务及其会话；仅有 callback.chatId 不足以证明来源。
无法核验的旧记录保留在 Redis 的 `xxb:meta:scope-held` 中，等待审查，不自动重放。
临时读取失败会保留输入等待重试，不允许退回到未验证的本地副本。
持久任务执行前也检查账号、目标用户与引用；摘要仍按同一 sourceChatId 读取，未知来源不公开。

全局唤醒只读取各会话的活跃度、冷场时间和任务编号等调度信息，不把聊天正文、
人名、主题、摘要或未说出口的想法放进跨会话提示。选定群或主人私聊后，正文再由
目标会话的上下文生成；同会话记忆和引用继续可用。缺少完整公开来源证明的原文
跨会话转发会被拒绝，兴趣评分不能代替分享许可。公开网页和 RSS 资讯仍可正常分享。
这些检查不改变 QQ 的短静默合并窗口或 Telegram 的原有调度节奏。

## Context Engine

`src/context-engine/`：按 `static|delta|ephemeral|volatile` 组装，并返回当前静态前缀边界。Manifest 的 `unchangedContextRatio` 只是本进程前后两次组装中未变化的字符占比，不是供应商缓存命中率。
Meta/CodeAct 将边界传入调用层；Claude 格式会在实际 system 的对应位置设置缓存断点。是否命中仍取决于实际供应商、模型、前缀长度和保留规则，见[缓存计量与验证](../prompt-cache.md)。

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
