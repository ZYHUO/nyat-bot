# NyatBot AGI-like 执行计划

> 状态：In progress（Phase 0–4 的基础纵向切片已实现；Phase 7 社会预测/修复评估基础已实现；Phase 8 复杂度路由 shadow 与受限 workspace 行为切片已实现；AGI-008 离线 paired replay 基础已实现；Agency authority/canary 仍关闭）
>
> 日期：2026-09-12
>
> 上位设计：[Cognitive Society Runtime](./2026-09-12-cognitive-society-runtime.md)
>
> 适用版本：`0.5.x` 及之后

本文把 CSR 方向拆成可以逐步发布、回放和回滚的工程任务。它不承诺“实现 AGI”，也不把模型能力、拟人话术或模块数量当作智能证据。这里的 “AGI-like” 只表示：系统能在长期运行中保持有范围的身份和世界状态，围绕目标持续行动，观察现实结果，修正错误，并把验证过的经验迁移到未见任务。

## 1. 成功定义

### 1.1 目标循环

所有需要深思或产生副作用的路径，最终都应能追溯到同一条闭环：

```text
外部事件
  -> 感知归一化
  -> 当前认知工作区
  -> 假设 / 目标 / 不确定性
  -> AgencyAction
  -> 权限与副作用校验
  -> 执行
  -> 外部结果与投递结果
  -> prediction error / debt transition
  -> 更新 Self / Person / Group / World / Skill
  -> 回放与评估
```

### 1.2 必须满足的系统性质

- **可持续**：进程重启、任务中断和下一天再次交互后，目标、债务、纠正和未决不确定性仍可恢复。
- **可证伪**：状态必须绑定来源、范围、置信度、有效期和反证路径，不能把模型自述当事实。
- **可行动**：同一套动作协议覆盖聊天、主动行为、工具任务、等待、观察、纠正和停止。
- **可观察**：每个决策、动作、工具调用、投递和结果都有可关联的事件 id。
- **可控**：副作用受 scope、权限、预算、幂等和人工闸约束，隔离失败时拒绝执行。
- **可评估**：进步用 held-out、回放和 ON/OFF 对照证明，不用单条回复主观打分。
- **高效**：普通闲聊走快路径；只有目标、债务、冲突、多步工具、高风险或异常误差才进入深路径。

### 1.3 非目标

- 不在本计划中训练新的基础模型。
- 不以“更像真人”“更会卖萌”“更多 prompt 层”作为主目标。
- 不在没有安全隔离和独立验收时开放任意主机命令、自主发消息或无审核自我改代码。
- 不把 multi-agent 角色数量、cron 数量或 token 消耗当作认知进展。

## 2. 当前基线

### 2.1 已有能力

- Redis/BullMQ durable queue、checkpoint、interrupt、任务生命周期和 CodeAct executor。
- Context Engine、SQLite/FTS/Qdrant 记忆、群关系、群规范、主动 tick 和多 Agent 编排。
- task evidence、goal evidence gate、skill lifecycle、verified experience、self-edit guardrails。
- Core v2 的 belief、blackboard、drives、proposal、permission 和 L2 executor 基础。
- CSR 新增的 cognitive debt、prediction、workspace、task runtime event 类型和统一动作类型。

### 2.2 目前的关键断点

1. [`src/agent/agency-runtime.ts`](../../src/agent/agency-runtime.ts) 已提供 durable run、policy、预算、attempt、receipt 和 adapter dispatch；[`src/agent/agency-delivery-adapter.ts`](../../src/agent/agency-delivery-adapter.ts) 提供显式 `speak/ask` transport factory 及 Telegram binding，[`src/agent/agency-wait-adapter.ts`](../../src/agent/agency-wait-adapter.ts) 提供带回执校验的 `wait` scheduler factory 及 timing FSM binding，[`src/agent/agency-control-adapters.ts`](../../src/agent/agency-control-adapters.ts) 提供 `observe/remember/correct/stop` callback factories；Reply 文本和五个 wait 入口已有默认关闭的 authority-only durable transport，但 Heart/其它 Meta 的完整动作注册仍未统一。
2. [`src/pipeline/pipeline.ts`](../../src/pipeline/pipeline.ts) 对 Core 使用 shadow compare，主行为仍由 legacy judge/reply 决定；Core L2 默认 dry-run。
3. [`src/agent/task-runtime-events.ts`](../../src/agent/task-runtime-events.ts) 保留进程内 `EventEmitter` 作为低延迟通知，但所有当前生产者已统一经 `emitTaskRuntimeEvent` 写入 durable cognitive event；CodeAct 主循环也会记录不含模型正文的 model-turn started/finished 边界；`listTaskRuntimeEvents`/`replayTaskRuntimeEvents` 可在重启后按 task correlation 重建生命周期，`getTaskRecoverySummary` 再把 checkpoint、工具/模型边界、等待/失败和 task evidence 聚合成不含正文的 acceptance/recovery summary；旧生产者仍需继续收敛到更细的专用事件类型。
4. Core belief/world/state 主要读取路径已传 scope；仍有少数 legacy caller 允许兼容 fallback，历史未 backfill 行不会进入 scoped workspace。
5. [`src/core/migrate.ts`](../../src/core/migrate.ts) 已将新 user profile belief 按 chat+uid 双写，`person_identity` 仍是跨群 uid 级别；历史 profile 合并行需要自然刷新或专项 backfill 才能完全消除 legacy scope。
6. [`src/agent/cognitive-workspace.ts`](../../src/agent/cognitive-workspace.ts) 已可被 Reply、Heart、Meta、CodeAct 和 unified tick 复用；Reply、Heart、Meta、CodeAct 与 unified tick 已能携带 durable message event anchor，仍有少数 legacy/background caller 未强制统一到同一个 event-anchored snapshot。
7. prediction 已有 host-observable feedback resolver、signed calibration、按 chat/user/action 的校准维度和 evidence-only debt resolution；0101 追加了达到最小证据量后写入的有界 prediction model revision ledger，但它只记录 host 事实，不自动修改 prompt、skill、policy 或长期信念。0102 再增加 metadata-only `social_interaction` 事件和有界可回放社交图；0103 增加显式 `SOCIAL_PREDICTION_ENABLED` 下的 engagement 预测、host 事实/沉默结算和冲突→修复→后续互动评估，0104 为 `group_norms` 增加 append-only revision 和 as-of 读取，0105 为 `chat_relationships` 增加 append-only revision 和带锚点衰减的 `getRelationshipAt`；这些仍只作为评测/投影输入，不改变回复策略。语义债务匹配已提供 host-owned bounded semantic scorer 契约，更完整的关系/假设自动更新仍未完成。
8. [`src/sandbox/terminal.ts`](../../src/sandbox/terminal.ts) 默认在 bwrap 不可用时 fail-closed；只有显式关闭 `SANDBOX_REQUIRE_ISOLATION` 才允许应急宿主回退，该模式不能作为自主执行安全边界。
9. holdout 和 spot-the-bot 是评测框架，不是通用能力、长期恢复或 AGI 结果；paired replay evaluator 只输出 engineering check，不能替代真实 held-out 运行。当前已增加真实 provider + CodeAct host 的首个 held-out/long-horizon execution window，但样本仍小，不能据此宣称 AGI-like 能力。
10. Phase 8 已有纯函数的 fast/deep/background 复杂度分类和 post-judge shadow 指标；另有默认关闭、按 chat 灰度的行为切片，非 fast Reply 可显式复用 scoped workspace，deep 回合在同一灰度门内可启用有界 grounding 专家与 critic，统一唤醒循环对有信号的 background tick 可按同一门读取工作区。researcher、CodeAct、Agency、发送副作用和后台队列仍不因路由自动开启；必须先积累成本/质量数据。

### 2.3 基线检查

当前 `main` 提交为 `b89ae5a`。本轮工作树的 typecheck、lint、build 通过；上一基线完整测试为 338 个文件、2725 个测试通过、4 个跳过；加入 social event graph、feedback bridge、complexity routing、Reply/wait authority bridge、social prediction ledger、受限 routing workspace 行为切片、Group/Person revision 回放、task runtime 重启回放、model-turn 生命周期事实、durable route observation window、route/Agency monitor 查询端点和 Meta dispatch decision observation 后最新完整测试为 350 个文件、2823 个测试通过、4 个跳过。跳过项是当前宿主无法创建 `NETLINK_ROUTE` socket 的 bwrap live 隔离探针，策略仍保持 fail-closed，不能据此扩大自主执行权限。

### 2.4 首个纵向切片执行记录（2026-09-12）

- 已完成 AGI-001：Core belief/world entity 增加持久化 scope key，双写按 chat/user 分离，读取和 L2 read tool 拒绝跨 scope；旧迁移测试保留兼容读路径。
- 已完成 AGI-002：新增 `SANDBOX_REQUIRE_ISOLATION`（默认 true）、能力查询和 fail-closed 执行；当前宿主 bwrap 不能创建网络命名空间，live isolation 测试自动标记为环境不支持而不放宽安全策略。
- 已完成 AGI-003 的基础部分：新增 `cognitive_events` append/dedupe/sequence/list/replay API、`cognitive_outbox` claim/ack/retry API，并接入 Telegram 入站/编辑、feedback、delivery 和 task runtime lifecycle 事件（只写 metadata，不写原文）。当前 projector 已消费严格限定 scope 的 `world_change`，以及带来源事件校验的成功 tool callback。
- 已完成 AGI-004 的基础部分：新增可重启、租约化、幂等边界明确的 `cognitive-outbox-worker`，支持批量 drain、retry、max-attempts 和显式 stop；`cognitive-projector` 处理 host-observable prediction feedback、带 source event 的 debt detection 和证据偿还，并把确定性 tool callback 作为 evidence resolution；CodeAct host wrapper 记录不含参数/正文的 tool started/finished 事实，主循环记录不含模型正文的 model-turn started/finished 边界，终态事件带验收状态；task runtime lifecycle 统一写入 durable event，并提供重启后的 task replay 读取。库层不隐式启动；`CRON_ENABLED` 且 `COGNITIVE_OUTBOX_ENABLED=true` 时由 scheduler 显式运行，债务创建仍由 `DEBT_AUTO_MATCH_ENABLED` 单独控制。
- 已完成 Phase 5 的恢复观测切片：`getTaskRecoverySummary` 从 durable task runtime correlation 和 host-owned `task_evidence` 聚合 `queued/running/waiting_user/done/failed`、checkpoint、模型/工具边界、interrupt/clarification、verified/unverified/failed acceptance 以及状态冲突；`GET /monitor/api/task-recovery` 只返回这些 metadata，task direction、模型输出、resolution 文本和工具参数不进入响应。它不改变 executor authority，也不把 lifecycle `done` 当作 verified success；真正的未见任务 holdout、重启注入和 time-to-recover 统计仍待真实样本执行。
- 已完成 AGI-005 的基础部分：`buildCognitiveWorkspace` 统一读取 scoped beliefs、world、goals、predictions、debts、pending actions，并保留 provenance/uncertainty/budget；Reply、Heart、Meta、CodeAct、unified tick 均有 opt-in 接入，默认仍关闭。
- 已完成 AGI-005 的下一步：新增 `src/agent/world-projection.ts`，把 Self/Person/Group/World 的 legacy tracking 行转换为带 scope、来源、置信度、状态和 expiry 的只读 hypothesis manifest；workspace 在 projection 可用时复用同一份实体快照，故障时保留旧读取回退。
- 已完成 AGI-005 的事件锚点下一步：`asOfEventId` 先做 chat/task scope 校验并解析 `occurredAt`，再约束 beliefs、goals、predictions、task evidence、legacy tasks 和 Self/Person/Group 读取；World 在有 revision history 时回溯到锚点版本，缺少历史能力的状态显式进入 uncertainty。
- 已完成 AGI-005 的 scope 收口：task-scoped world entity 只对同一 task、所属 chat 和 global facts 可见；workspace 的 legacy world/self fallback 也传递事件锚点，避免投影不可用时悄悄回到实时状态。
- 已完成 AGI-006 的基础部分：新增 durable `agency_runs` 与 `AgencyActionEnvelope`，支持风险/预算校验、幂等、adapter dispatch、取消、超时和状态事件；随后补充 `agency_attempts`、`execution_receipts` 和 adapter 可消费的 LLM/tool usage meter；尚未接入 authority/canary。
- 已完成 AGI-006 的下一步：新增 host-owned Agency policy facade，统一 `shadow/advisory/canary/authority`、canary chat 白名单、LLM/tool 硬预算和 fail-closed dispatch；默认仍为 `shadow`，不会改变 legacy 行为。
- 已完成 AGI-006 的终态收口：`createAgencyRun` 在落库前重新校验 action/scope/risk/budget/idempotency，过期状态转移只在数据库竞争成功时写 receipt，避免取消/抢占竞争产生伪终态记录。
- 已完成 AGI-006 的主流程 shadow bridge：Core L1 judge proposal 以不含回复正文的 `observe` Agency action 写入 durable run，使用稳定幂等键，并优先以触发它的 Telegram/cognitive event 作为 causation；默认 `shadow` policy 将其置为 `waiting`，并把 `agencyRunId` 带回 Core 结果，仍不改变 legacy 行为。
- 已完成 AGI-006 的 readonly adapter bridge：原有 permission gate 打开时，`memory.search`、`chats.recentMessages`、`web.search` authorized intent 通过结构化 `observe.args` 进入 Agency；shadow 只等待，advisory/canary/authority 才可执行，并以 deterministic blackboard receipt 兼容旧 L2 观察面；写类动作仍未迁移。
- 已完成 AGI-006 的显式 delivery adapter factory：`speak/ask` adapter 强制使用持久化 chat scope，透传完整 `CognitiveScope`、`runId`、attempt、correlation/idempotency 元数据，发送结果必须是有效 `messageId` 并计入 tool budget；同时提供延迟加载 Telegram binding。factory 仍需调用方显式注册，未接入默认 pipeline。
- 已完成 AGI-006 的 legacy Reply 观测桥：`AGENCY_LEGACY_REPLY_OBSERVATION_ENABLED` 打开时，Reply 只在 Telegram 返回真实 `messageId` 后创建/结算 observed speak run，按触发消息和投递 id 幂等，失败或重复不会重发；默认关闭，未授予 Agency 发送权限。
- 已完成 AGI-006 的显式 wait adapter factory：`createAgencyWaitAdapters` 复用 scoped chat、取消检查、tool budget 和完整 scope/correlation/idempotency 透传，scheduler 必须返回 `waitUntil`（可选 `waitJobId`）才算成功；`createTimingAgencyWaitAdapters` 只在显式 dispatch 时绑定现有 WAIT/恢复 FSM，主 pipeline 仍未注册。
- 已完成 AGI-006 的控制 adapter factories：`observe/remember/correct/stop` 均由 host callback 承担实际能力，适配器统一执行 scoped chat、完整 scope 透传、取消、tool budget 和 bounded receipt 校验；`correct` 只有在 host 确认 evidence resolution 后才成功，避免模型自证债务已偿还。
- 已完成 AGI-006 的 CodeAct adapter factory：`createAgencyActAdapters` 将结构化 goal 交给调用方的任务/队列 host，透传完整 scope、run/attempt/correlation/idempotency 元数据并计入 tool budget；只有 host 返回 durable `taskId` 和 `acceptedAt` 才结算 succeeded，主 CodeAct pipeline 仍未注册。
- 已完成 AGI-006 的显式 CodeAct queue binding：`createCodeActAgencyActAdapters` 延迟加载现有 `enqueueCodeActJob`，以 Agency run id/显式 task id 建立 queued task 并只在 queue host 返回后结算接受回执；构造 factory 不连接 Redis、不自动排队，主流程仍未注册。
- 已完成 AGI-006 的 policy 风险收口：`evaluateAgencyPolicy` 由 host 重新推导 action risk，调用方提供不一致的 `risk` 会以 `risk_mismatch` fail-closed，不能把不可逆动作伪装成 read。
- 已完成 AGI-003/004 的 CodeAct 入队事实补齐：普通和续跑 queue 在 BullMQ 或本地 fallback 成功接受后记录 `task_queued` durable lifecycle event；队列失败且 fallback 也失败时不伪造接受事件。
- 已完成 AGI-006 的首个主路径 transport wiring：新增 `AGENCY_CODEACT_TRANSPORT_ENABLED` 和 authority-only `dispatchCodeActTaskViaAgency`，Meta CodeAct 入队在显式 authority 下先创建 Agency envelope/run、通过 queue host 验收 durable task receipt；shadow/advisory/canary 仍走 legacy，authority 失败不绕过策略回退。
- 已完成 AGI-006 的失败清理收口：Meta CodeAct 在 Agency authority 拒绝、本地 fallback 失败或 active lock 竞争失败时，按 task id 条件释放 Redis quote claim，避免失败任务把原消息锁到 TTL 结束；不删除其他任务持有的 claim。
- 已完成 AGI-006 的 Reply authority transport wiring：新增 `AGENCY_REPLY_TRANSPORT_ENABLED` 和 `dispatchReplyViaAgency`，主 Reply 文本段在显式 authority 下先创建 durable `speak` run，再由 Telegram adapter 返回真实 `messageId` 才结算成功；ack、贴纸、投票、reaction、voice 和 humanizer 二次发送/编辑均在该模式关闭，失败不回退 legacy，默认仍关闭。
- 已完成 AGI-006 的 wait authority transport wiring：新增 `AGENCY_WAIT_TRANSPORT_ENABLED` 和 `dispatchWaitViaAgency`，Heart、Meta Heart、Meta timing/dispatch gate 与 pipeline gate 均先保留 replay anchor，再通过 durable `wait` run 让 timing FSM 返回真实 `waitUntil/waitJobId`；Reply、wait、CodeAct authority envelope 与 legacy delivery observation 优先把原始 Telegram/cognitive event 作为 `causationId`，task runtime 的 queue/start/tool/delivery/wait/terminal 生命周期也会保留任务锚点并支持重启 replay；无锚点时保留兼容 fallback。启用后 wait 失败不调用 legacy `transitionToWait`，默认仍关闭。
- 已完成 AGI-006 的 Meta dispatch observation bridge：`dispatch.taskToGroup` 的 proposed、blocked、skipped、lock/gate/Agency rejection 分支均写入 metadata-only `observe` Agency run；quote 优先使用消息锚点，无 quote 的主动任务使用 task/事件锚点并落在 task scope。默认 shadow 下只保留 waiting proposal，legacy queue/发送仍是权威；`GET /monitor/api/agency-runs` 只返回脱敏生命周期 summary，不暴露 action 参数、模型方向或 adapter result。
- 已完成 AGI-009 的基础部分：新增只读默认的 `replayCognitiveCorrelation`，可按 correlation/sequence 重放事件并显式选择是否应用同一 deterministic projector。
- 已完成 AGI-008 的离线基础部分：新增 `src/eval/agi-like-evaluator.ts`，对同一事件切片运行 legacy/core × memory/skill/prediction ON/OFF 变体，输出 host outcome、false-success、人工介入、修复、延迟/调用成本、聚合 Wilson 95% 区间和 paired delta 区间；report evidence 同时固定代码版本、配置快照、样本数、事件时间范围、实验组、受限失败样本和 uncertainty。可选写入 `replay_experiments`，执行器异常按 `blocked` 记录且不保存原始异常。
- 已完成 AGI-007 的基础部分：新增 0093 scope/provenance 列、0094 `resolution_event_id`、事件 dedupe 债务、evidence-only debt resolution、prediction feedback 回填和 `[-1,1]` signed calibration（旧 0088 行保持兼容语义）；0096 为 world entity 增加 append-only revision history，0097 为 skill lifecycle 增加候选/发布/回滚 revision ledger，0099 为债务增加 append-only 快照和锚点回放读取，0100 为 prediction 增加 user/action 维度，0101 为达到最小 host 证据量后追加有界 calibration revision ledger，0105 为关系快照增加 append-only revision 和 `getRelationshipAt` 锚点读取。另新增 `findRelatedDebtsScoped`，按 task/user/chat/source-event anchor 先于有界文本 overlap 做确定性匹配，并接入 workspace 当前消息排序；revision ledger 仍是只读审计输入，不自动改 prompt、skill、policy 或 belief；workspace 已提供 host-owned、有界、默认关闭的 semantic scorer 契约，但反证驱动的长期更新、迁移前 legacy 债务的早期历史和更深的 Self/Person/Group hypothesis 自动更新仍待后续阶段。
- 已补 Phase 6 的验证血缘切片：`verifySkill` 会把 host 静态检查（proposal JSON、必填字段、红线、已发布同名唯一性）写入 `skill_revisions.test_summary`，通过与失败都可回放；`listSkillRevisionVerificationSummaries`/`GET /monitor/api/skill-verifications` 仅投影 revision 状态、验证器、检查项名称和通过/失败计数，供 release/evaluation window 查询，不暴露 artifact、步骤、检查原因或回滚文本。这不是 held-out 行为测试，发布仍必须经过主人 `approve`，真正的跨任务负例/回归验证仍待后续阶段。
- 已完成 Phase 7 的 replayable social foundation：0102 为 `social_interaction` 事件增加 chat/time 索引，`social-event-graph` 对 reply-chain 和 feedback host outcome 旁路记录 metadata-only 的有向互动事实（reply/support/conflict/repair），并提供 chat/user/as-of 过滤与时间衰减图读取；无正文、无跨群身份合并、无社交策略副作用。
- 已完成 Phase 7 的 social prediction/repair evaluation 基础：0103 新增 bounded `social_predictions` ledger；显式 `SOCIAL_PREDICTION_ENABLED` 下群投递记录 engagement 先验，目标用户的 reply/reaction/conflict/repair 事件或观察窗沉默结算真实分数和 signed error，并以 `evaluateSocialRepairs`/`summarizeSocialRepairs` 做冲突→修复→后续互动的只读评估；不自动改关系、群规范、prompt 或回复策略。
- 已完成 Phase 7 的 Group hypothesis 历史切片：0104 为 `group_norms` 保留 append-only revisions，`getGroupNorms(chatId, asOf)` 在有历史时按锚点读取旧规范；旧库只生成单条 legacy 快照，无法推断迁移前更早变化，仍不自动改回复策略。
- 已完成 Phase 7 的 Person hypothesis 历史切片：0105 为 `chat_relationships` 保留 append-only revisions，`getRelationshipAt(chatId, uid, asOf)` 在有历史时按锚点读取旧关系并以锚点时间衰减；旧库只生成单条 legacy 快照，缺少历史时 Person 投影显式保留 uncertainty，仍不自动改回复策略。
- 已完成 Phase 8 的复杂度路由基础：`src/agent/cognitive-routing.ts` 以纯函数识别目标、未偿还债务、待恢复任务、多步工具、外部查询、纠正/冲突、高风险副作用、异常预测误差和长上下文，输出可解释的 `fast/deep/background` 决策；post-judge 在 `COGNITIVE_ROUTING_ENABLED` 打开时记录 shadow counter/log，并在真正进入 reply generation 的回合写入 0106 durable route observation，delivery 结算发送/静默/失败/中断与延迟、工具数、回复数，outcome tracker 回填用户正负反馈；这些 telemetry 不增加 LLM 调用、不授予 Agency 权限。后续仍需用真实成本/质量窗口验收深 Reply 专家和有信号 background workspace 的收益。
- 已完成 Phase 8 的首个行为切片：新增 `COGNITIVE_ROUTING_BEHAVIOR_ENABLED` 与 `COGNITIVE_ROUTING_CHAT_IDS`，命中灰度且 route 为 deep/background 的 Reply 才显式复用 scoped workspace；deep 回合再有界启用记忆/人设/导演/上下文 digest 与 critic grounding，researcher、CodeAct、Agency 权限和发送副作用均不受路由自动影响，默认关闭。
- 最终验证：`npm run typecheck`、`npm run lint`、`npm run build`、`git diff --check` 和 `npm test` 均通过；本轮全量结果为 350 个测试文件、2823 个测试通过、4 个跳过（其中 4 个是当前宿主 bwrap 无法创建 `NETLINK_ROUTE` 的 live 隔离探针，策略仍保持 fail-closed）。
- 首次真实 held-out/long-horizon execution window（2026-09-14）已完成：新增 [`scripts/eval-long-horizon-live.ts`](../../scripts/eval-long-horizon-live.ts)、[`src/eval/long-horizon.ts`](../../src/eval/long-horizon.ts) 和 5 例固定任务集，任务实例和多回合 CodeAct 协议不复用旧的 arithmetic/ledger smoke fixture。每例要求 3--5 个模型回合，使用真实 provider `step-3.7-flash`、真实 `createHostApi`/`runHostCodeForTest`、每例独立 sandbox 和临时 SQLite；Telegram 未启动，terminal/browser 关闭，Telegram/memory/web/meta 等外部命名空间由 harness 拒绝，caller-owned acceptance 在 host 外独立复核。完整原始汇总见 [`2026-09-14-long-horizon-live.json`](../eval-results/2026-09-14-long-horizon-live.json)。
- 结果：`2/5` verified，pass rate `40%`；`4/5` 最终 artifact 通过 caller acceptance（`80%`）；所有 case 都跑满最低 3 回合（horizon requirement `100%`），持久 task runtime event 共记录每例的 model/tool/terminal lifecycle。通过的是 multi-artifact reporting（1 次可恢复验收失败后修复）和 verification/repair；失败的是 ledger join（artifact 对但有 provider 空响应和未 settle tool promise）、latest-record dedup（provider 空响应、sandbox escape/unsafe code attempt、未收尾）以及 inventory planning（artifact 对但 5 回合内未显式 `endTask`）。
- 这轮的主要结论不是“算对了就算完成”：artifact success 高于 clean task success，模型收尾、工具 promise settle、越权代码拒绝和 provider transient failure 都必须计入可靠性。下一轮应重复同一 runner，加入 crash/restart、interrupt/goal-change、更多领域和真正 external acceptance，再比较窗口而不是把本次 `40%` 当作能力总分。
- 安全状态：`CORE_PERMISSION_GATE_ENABLED` 未因本轮改动开启；`AGENCY_RUNTIME_MODE=shadow`、`AGENCY_CODEACT_TRANSPORT_ENABLED=false`、`AGENCY_REPLY_TRANSPORT_ENABLED=false`、`AGENCY_WAIT_TRANSPORT_ENABLED=false`、`SOCIAL_PREDICTION_ENABLED=false`、`COGNITIVE_WORKSPACE_V2_ENABLED=false`、`COGNITIVE_ROUTING_BEHAVIOR_ENABLED=false`、`DEBT_AUTO_MATCH_ENABLED=false`、`AGENCY_LEGACY_REPLY_OBSERVATION_ENABLED=false`，Agency 只有显式调用的 readonly、`speak/ask`、`wait`、CodeAct 和 control adapter factories（含 Telegram/timing binding）及可选的已发送结果观测桥；Reply/wait authority bridges 默认关闭，未授权或策略拒绝时不会产生真实副作用。

## 3. 目标架构

### 3.1 平面划分

```text
Ingress / Telegram / Scheduler / Tool callbacks
                |
                v
Perception + Event Log + Outbox
                |
                +--> State Projections
                |      - Self
                |      - Person
                |      - Group
                |      - World
                |      - Goals
                |      - Cognitive Debts
                |      - Predictions
                |
                v
Cognitive Workspace (scoped, versioned, provenance-aware)
                |
                v
Deliberation / Fast path / Deep path
                |
                v
AgencyAction Dispatcher
                |
                +--> Reply adapter
                +--> Heart / proactive adapter
                +--> Meta adapter
                +--> CodeAct adapter
                +--> Observe / wait / remember / correct adapter
                |
                v
Host Policy + Executor + Receipt
                |
                v
Outcome Observer -> prediction/debt/model updates -> evaluation
```

### 3.2 数据所有权

- **SQLite**：事件、动作、结果、状态投影、证据、实验结果的 durable source of truth。
- **Redis/BullMQ**：队列、锁、唤醒、短期协调和 outbox 投递，不作为唯一事实存储。
- **Context Engine**：负责上下文预算、分层和 manifest，不负责定义事实。
- **Qdrant/FTS**：负责检索候选，不直接改变 belief、goal 或 skill 的可信度。
- **LLM**：提出解释、假设、计划和动作候选；不能自行授予 caller evidence、verified、权限或 scope。
- **Host**：负责权限、范围、资源、执行、验收、结果和状态迁移。

## 4. 核心数据契约

### 4.1 Scope

所有会影响模型或产生副作用的记录必须有规范化 scope。不要依靠调用方记得加过滤条件。

```ts
type Scope = {
  visibility: 'global' | 'chat' | 'user' | 'task';
  chatId?: number;
  userId?: number;
  taskId?: string;
};
```

规则：

- `global` 只能存真正跨群的 Self 或公共知识。
- `chat` 可以被该群的决策读取，但不能被其他群读取。
- `user` 只有在当前 chat 可见且用户允许时才可读取。
- `task` 只对任务执行、验收和恢复路径可见。
- projection、检索、prompt 渲染、工具参数和日志审计都必须再次校验 scope。

### 4.2 CognitiveEvent

建议新增 `cognitive_events` 表，事件是不可变事实，解释和投影另存。

```ts
interface CognitiveEvent {
  id: string;
  type:
    | 'message_received'
    | 'message_edited'
    | 'user_correction'
    | 'user_goal_change'
    | 'user_stop'
    | 'task_observation'
    | 'tool_failure'
    | 'bot_delivery'
    | 'user_reaction'
    | 'user_followup'
    | 'world_change';
  scope: Scope;
  source: 'telegram' | 'host' | 'scheduler' | 'tool' | 'model' | 'import';
  occurredAt: number;
  sequence: number;
  causationId?: string;
  correlationId: string;
  dedupeKey?: string;
  rawRef?: string;
  fact: Record<string, unknown>;
}
```

事件不得把 secrets、完整工具 body 或不必要的私聊原文写入通用日志。原始内容走已有 visibility/memory 机制，event 只保存必要的引用和摘要。

### 4.3 AgencyActionEnvelope

现有 `AgencyAction` 需要保留为模型动作的最小形状，再由 host 包成执行信封。

```ts
interface AgencyActionEnvelope {
  id: string;
  correlationId: string;
  causationId?: string;
  scope: Scope;
  action: AgencyAction;
  risk: 'read' | 'reversible' | 'irreversible';
  budget: { maxMs: number; maxLlmCalls: number; maxToolCalls: number };
  expectedOutcome?: string;
  idempotencyKey: string;
  createdAt: number;
  expiresAt?: number;
}
```

执行器必须先验证 envelope，再解析 action。所有拒绝、取消、超时和重复执行都写 receipt。

### 4.4 Belief / Hypothesis

```ts
interface BeliefRecord {
  id: string;
  scope: Scope;
  subject: string;
  predicate: string;
  summary: string;
  sourceEventIds: string[];
  confidence: number;
  supportCount: number;
  refuteCount: number;
  formedAt: number;
  lastConfirmedAt?: number;
  expiresAt?: number;
  supersededBy?: string;
  status: 'active' | 'stale' | 'contradicted' | 'superseded';
}
```

任何 prompt 注入必须带 scope、来源和不确定性信息。原始 reflection 不能直接等同于 Self model。

## 5. 工作流和阶段

每个阶段必须先完成退出条件，再扩大行为范围。阶段可以并行开发，但发布顺序不能跳过 P0 安全和作用域要求。

### Phase 0: Correctness and safety baseline

优先级：P0。目标是阻止错误状态和不安全执行继续扩大。

任务：

- 修复 Core belief 读取的 chat/user scope，给 `core_beliefs` 增加规范化 `scope_key` 或等价字段和索引。
- 修复 `syncUserProfile` 的唯一键，明确区分本群 profile 与跨群 person identity。
- 给 `world_entities` 增加 scope、visibility、source event、confidence、expiry；`buildWorldStateBlock` 必须按 scope 查询。
- `getActiveBeliefs`、`findEntities`、`listOpenDebts` 和 workspace 所有读取接口默认要求 scope，不提供无意的全局 fallback。
- L2 的 `memory.search` 和 `chats.recentMessages` 校验工具参数不能越过 intent scope。
- bwrap、容器或独立 UID 不可用时 fail-closed；禁止自动回退宿主 shell。
- 增加启动自检：隔离、网络、挂载、可写目录、资源限制不满足时标记 autonomous execution unavailable。
- 更新 `docs/core-v2.md` 中过期的 Phase 状态和 `/skill` 接线说明。

验收：

- 构造两个群、同一 uid、不同 profile，任何 Core/workspace/world 查询都不能读到另一群数据。
- 构造无权限的跨 chat L2 intent，必须在 host gate 被拒绝并有 receipt。
- bwrap 启动失败时不得执行宿主命令；隔离能力缺失时任务状态为 blocked/unavailable。
- 旧任务、旧 migration、旧 prompt 路径的行为保持兼容，不删除历史数据。

### Phase 1: Durable perception and event log

优先级：P0。目标是让系统拥有可回放的现实轨迹。

任务：

- 新增 `migrations/0089_cognitive_events.sql`，至少包含：`id`、`type`、`scope_key`、`chat_id`、`user_id`、`task_id`、`source`、`occurred_at`、`sequence`、`causation_id`、`correlation_id`、`dedupe_key`、`fact_json`、`created_at`。
- 新增 `src/agent/cognitive-events.ts`，提供 append、get、list、ack、dedupe 和按 correlation replay API。
- 在同一 SQLite transaction 中写 event 和需要的 projection/outbox 状态；Redis 只负责异步唤醒。
- 把 Telegram 入站、编辑、reaction、用户纠正、followup、stop、bot delivery、tool start/finish、task checkpoint/failure 全部映射到事件。
- 用 `eventId`、`correlationId`、`causationId` 串联消息、动作、工具调用、投递和实际结果。
- 增加 crash/restart 后从 outbox 重放的消费者；消费者必须幂等。
- 逐步替换 `task-runtime-events` 的生产用途，EventEmitter 只保留为本进程低延迟通知。

验收：

- 同一 Telegram update、同一 tool callback 重复投递不会产生重复事实或重复动作。
- 在 event append、action dispatch、delivery 之间人为杀进程，重启后可以恢复到正确状态。
- 回放同一 correlation 得到确定的事件顺序和相同的 projection 结果。
- event 记录不包含 token、refresh token、完整私聊原文或生成代码。

### Phase 2: Unified scoped cognitive workspace

优先级：P0。目标是让所有行为路径看到同一份、带证据的当前状态。

任务：

- 把 `buildCognitiveWorkspace` 升级为唯一的 workspace assembler，输入 `Scope + asOfEventId + budget`。
- workspace 统一包含：当前消息、Self、目标用户、群状态、相关世界实体、active goals、open debts、predictions、task evidence、uncertainties、pending actions 和 provenance。
- legacy reply、Heart、Meta、CodeAct、unified tick 都只读取 workspace snapshot，不各自拼一套互相冲突的状态。
- 每个 ContextPart 带 `provider/source/scope/confidence/expiry` manifest；敏感块在渲染前再次做 visibility 检查。
- 将 `core/state.ts` 的 agenda、skills、drives 占位替换为真实的 scoped projection，或明确禁止它们在该路径注入。
- Self model 从“最新几条反思文本”升级为带证据、范围、过期和撤销条件的 hypothesis。
- Person/Group/World 保留当前 tracking 模块作为数据来源，但通过统一 projection 暴露。

验收：

- 同一事件在 reply、Heart、Meta、CodeAct 四条路径得到一致的目标、债务和 uncertainty 视图。
- scope、expiry、contradicted、superseded 状态在所有渲染路径一致生效。
- 未经 host 验证的任务完成声明只能进入 uncertainty，不能进入 verified belief 或 positive experience。

### Phase 3: Agency runtime and Core canary

优先级：P0/P1。目标是让 Core 从观察者变成受控的决策和执行入口。

任务：

- 新增 `src/agent/agency-runtime.ts`：`propose -> validate -> authorize -> dispatch -> observe -> settle`。
- 新增适配器：`reply-adapter`、`heart-adapter`、`meta-adapter`、`codeact-adapter`、`wait-adapter`、`observe-adapter`、`remember-adapter`、`correct-adapter`、`stop-adapter`。其中 `wait-adapter` 先以显式 host scheduler contract 落地，`codeact-adapter` 先以显式 task/queue contract 落地，实际主路径注册仍需统一 anchor/trigger/obligation 语义。
- legacy judge、Heart、Meta、CodeAct 暂时保留为后端，不再拥有独立的终态语义。
- 为每个动作写 `agency_runs`、`agency_attempts`、`execution_receipts`，并支持 cancel、timeout、retry、resume 和 idempotency。
- 把 `CORE_PERMISSION_GATE_ENABLED` 改造成运行模式，而不是单个布尔开关：`shadow`、`advisory`、`canary`、`authority`。
- Core 先只在一个测试群进入 `advisory`，再只接管只读动作，之后接管可逆动作；不可逆动作继续人工确认。
- 所有 L2 工具通过同一 host policy，read 工具也必须校验参数 scope。
- action 不能以“发送了任意文字”作为完成；完成必须由对应 outcome/acceptance 证明。

验收：

- 每个收到的深路径事件都能找到唯一 action envelope、执行 receipt 和 outcome 或明确的 waiting/blocked 状态。
- 重试不会重复发消息、重复写文件或重复完成 goal。
- Core canary 与 legacy 的差异可回放，任何异常能一键切回 advisory/shadow。
- 普通闲聊仍可走 legacy fast path，不被强制增加深路径 LLM 调用。

### Phase 4: Cognitive debt and prediction error loop

优先级：P0/P1。目标是把“尚未解决”和“我预期会怎样”变成真实的后续行为改变。

任务：

- 新增 debt detector，从 promise、uncertainty、correction、waiting、unfinished task、conflict、stale belief 事件生成债务。
- 为 debt 增加 `sourceEventIds`、owner scope、related entity、nextCheckAt、resolution event、supersededBy 和 dedupe key。
- 在每个新事件进入 workspace 前，先做 deterministic match，再做受预算限制的 semantic match；不得只靠模糊关键词自动偿还。
- 增加 `correct`、`reverify`、`snooze`、`supersede`、`resolve` 动作，并要求 resolution evidence。
- 预测使用与 actual 相同的量纲；当前 `0.5` prior 与 `[-1, 1]` feedback 必须统一。
- 预测只在高价值或高副作用动作启用，记录预期结果、置信度、时间窗和观察条件。
- actual 来源优先级：host acceptance、真实工具结果、用户纠正、用户 reaction、followup；模型自评只做辅助信号。
- 实现 prediction resolver、校准统计和更新策略。单次误差不直接改变长期模型，至少经过重复证据和置信度门槛。
- 更新必须写入 event 和 model revision，能够回答“哪次结果改变了哪条 belief/skill/policy”。

验收：

- 用户第二天再次提到相关主题时，系统能识别并处理对应 debt，而不是只检索相似文本。
- 被纠正后会修正原 belief，并在相同场景下减少重复错误。
- prediction 的量纲、calibration、MAE/Brier 或等价指标可按 chat、user、action type 分组查看。
- 没有实际结果的 prediction 不会奖励 skill、不自动提高 confidence。

### Phase 5: General task competence and long-horizon recovery

优先级：P1。目标是从“能完成固定 CodeAct 任务”扩展到未见任务和变化环境。

任务：

- 引入可信的 external acceptance contract。caller contract 和 model-proposed checks 必须区分，模型不能伪造 caller provenance。
- 扩充 holdout domains：编程修复、数据处理、信息核验、文档产出、浏览器交互、跨工具任务和社会信息整理。
- 每个任务至少覆盖：明确目标、隐含约束、错误输入、工具失败、用户澄清、部分交付、重启恢复和环境变化。
- 验收从“文件存在”升级为目标相关的结构、内容、来源、投递和可用性检查。
- 将 task executor 的 checkpoint、workspace snapshot、action receipt 和 evidence contract 绑定，支持按 event replay 恢复。
- 统计 verified success、false success、human intervention、repair attempts、time-to-recover、cost 和 retention。

验收：

- 在未见任务集上比较 memory/skill ON 与 OFF，冻结基础模型和预算，报告置信区间。
- 人为中断、重启、工具异常和外部事实变化后，系统能继续、改路线、请求澄清或明确停止。
- 任务失败不会被 lifecycle `done` 或模型文字自动包装成成功。

### Phase 6: Safe skill transfer and self-improvement

优先级：P1。目标是让经验成为可验证、可迁移、可回滚的能力。

任务：

- skill artifact 使用版本化结构：`preconditions`、`effects`、`allowedTools`、`risk`、`steps`、`checks`、`failureModes`、`sourceEpisodes`、`scope`。
- skill lifecycle 保持 `proposed -> verified -> approved -> published -> deprecated`，但 verify 必须实际运行最小测试和负例。
- 发布前在 held-out 任务和历史回放上做回归，失败自动阻止 publish；发布后支持按版本 rollback。
- `verified_use_count` 只能由 host-verified task 增加，retrieval/use count 不能代替效果证据。
- self-edit 继续限制在 prompt 目录，但改动必须先生成 candidate revision，经过独立 verifier、回放和人工或策略审批后才切换。
- candidate 的 motive、差异、测试结果、失败结果和 rollback 原因写入 revision ledger。
- 跨群、跨用户、跨领域迁移必须有 scope 和 held-out 证据，不能因为一次成功就全球发布。

验收：

- 一个 skill 在未见任务上的提升可以与无 skill 基线比较。
- 负例和权限边界测试通过前不能发布。
- 新版本造成回归时可自动回退到上一个 verified version，不改写历史证据。

### Phase 7: Group social world model

优先级：P1。目标是把已有关系、角色、规范和话题统计变成可更新的社会模型。

任务：

- 建立 group event graph：成员、互动、话题、规范、冲突、调停、回应和沉默窗口。
- Person/Group hypothesis 绑定证据、scope、时间和反例，不把 profile summary 当作永久事实。
- 记录插话、等待、主动关心、转发和纠正后的实际结果，形成 social prediction error。
- 评估“何时不插话”“谁会接话”“同一句话在不同群如何变化”“一次失误能否修复”，而不是只评估句子像不像真人。
- 对用户隐私、匿名消息、跨群身份和主人权限设置单独的 visibility policy。

验收：

- 同一句输入在不同群体关系和规范下可产生不同但可解释的 action choice。
- 系统能识别不应打断的窗口，并在社交失误后完成一次修复。
- 社会模型更新不会跨 visibility boundary 污染其他群。

### Phase 8: Fast/deep/background routing and cost control

优先级：P1。目标是让认知闭环可长期运行，而不是每条消息堆模型调用。

任务：

- 引入确定性 complexity trigger：目标、未偿还 debt、多步工具、冲突、纠正、高风险副作用、异常 prediction error。
- 快路径只读少量 scoped state，最多一次主模型调用，不额外启动 planner/critic/specialists。
- 深路径才启动 workspace、planner、verifier、CodeAct 或多 Agent 专家，并有硬预算和超时。
- 后台处理 reflection、relation、group model、debt sweep、prediction aggregation、skill test 和 expiry，不阻塞 Telegram 回复。
- 记录每种路由的 token、latency、失败、重试和用户中断，按收益/成本调整开关。
- 当前 multi-agent 全量开启的配置改成按路由和群灰度，不以默认全开作为长期策略。

验收：

- 普通闲聊的 LLM 调用数、P95 延迟和 token 成本不因 CSR 默认增加。
- 深路径有明确的进入原因和退出原因，超预算时会等待、降级或停止。
- 后台故障不影响主回复和任务安全状态。

### Phase 9: Replay, evaluation and observability

优先级：P0/P1。目标是让每次架构变化都能被证伪。

任务：

- 新增 replay runner：从 `cognitive_events` 重建 workspace、决策、动作和 projections，可注入固定模型响应。
- 新增 paired evaluator：同一事件集分别运行 legacy/core、memory ON/OFF、skill ON/OFF、prediction update ON/OFF。
- 保留现有 evidence harness 和 spot-the-bot，但明确标注其适用范围。
- 持续性指标：1 天/7 天目标 retention、debt repayment、纠正记忆、重复错误率、uncertainty honesty。
- 行动指标：verified success、false success、repair rate、路线切换、部分交付、恢复时间、人工干预。
- 社会指标：不必要插话率、相关性、修复成功率、跨群泄漏为零、负面反馈和打扰成本。
- 运营指标：P50/P95 latency、LLM/tool calls、token cost、queue lag、event loss、duplicate action、sandbox denial、rollback count。
- 每个指标保留样本数、时间窗、版本、实验旗和置信区间，不只写一条平均数日志。

验收：

- 每次 canary 都有冻结的 baseline、实验组、回滚条件和结果报告。
- replay 能复现至少一个真实失败，并验证修复确实改变了结果。
- 没有外部验收、held-out 或长期数据时，报告必须明确写“不足以支持 AGI/AGI-like 结论”。

## 6. 数据库和模块落点

### 6.1 建议新增 migration

基础切片已将 migration 追加到 `0105`；后续 migration 继续顺延，不重写历史：

- `0089_cognitive_events.sql`：不可变认知事件和唯一 dedupe key。
- `0090_scope_boundaries.sql`：Core beliefs/world entities 的 scope 和 legacy backfill（AGI-001 已落地）。
- `0091_cognitive_outbox.sql`：projection/worker 投递状态和重试。
- `0092_agency_runs.sql`：action envelope、attempt、receipt、outcome 关联。
- `0093_scope_columns.sql`：debts、predictions 的 scope 和 provenance（基础列、legacy 兼容与 signed prediction 已落地）。
- `0094_debt_resolution_provenance.sql`：债务偿还 evidence event id 和索引（已落地）。
- `0095_agency_attempts_receipts.sql`：Agency attempt、execution receipt 和幂等关联（已落地）。
- `0096_world_model_history.sql`：实体/假设的 revision、反证、supersession 和 expiry（world_change 的严格 scope projection 已接线）。
- `0097_skill_revisions.sql`：skill artifact 版本、测试、发布、回滚 ledger（lifecycle propose/verify/approve/publish/version/rollback 已接线；发布版本回滚会归档当前 artifact 并恢复最近上一版）。
- `0098_replay_experiments.sql`：实验、样本、版本、指标和置信区间（paired replay 基础已落地）。
- `0099_cognitive_debt_revisions.sql`：债务 append-only 快照、scope/status/time lookup 索引和 SQLite insert/update 触发器；旧行只标为 legacy 快照，不推断迁移前历史。
- `0100_prediction_dimensions.sql`：prediction 的 `user_id`、`action_type` 维度列和校准聚合索引（兼容旧表，按 chat/user/action 分组）。
- `0101_prediction_model_revisions.sql`：按维度 append-only 的有界 calibration revision ledger；达到 3 条 resolved host evidence 后写入，幂等且不直接改变运行策略。
- `0102_social_event_graph.sql`：`social_interaction` cognitive event 的 chat/time 索引；事件日志仍是社交事实源，不新增可变关系快照。
- `0103_social_predictions.sql`：群投递 social expectation、host-observed outcome/error、观察窗沉默结算和 bounded calibration 查询；默认关闭，不改变回复策略。
- `0104_group_norm_revisions.sql`：群规范 append-only revision、legacy 快照和事件锚点读取索引。
- `0105_relationship_revisions.sql`：关系 append-only revision、legacy 快照和按 chat/user/time 的事件锚点读取索引。
- `0106_cognitive_route_observations.sql`：复杂度路由的 durable 成本/质量 observation、终态指标和反馈索引。

不要重写历史 migration。所有新表和新增列都要支持旧数据读取、回滚和幂等初始化。

### 6.2 建议新增或重构模块

- `src/agent/cognitive-events.ts`：事件 append、dedupe、sequence、replay、outbox。
- `src/agent/agency-runtime.ts`：动作生命周期、dispatcher、cancel、resume、settle。
- `src/agent/agency-policy.ts`：scope、risk、budget、permission、side effect policy。
- `src/agent/workspace.ts`：统一 scoped snapshot 和 provenance manifest。
- `src/agent/debt-engine.ts`：创建、匹配、偿还、重开、过期和 resolution evidence。
- `src/agent/prediction-engine.ts`：预测、观察、误差、校准和模型更新。
- `src/agent/world-projection.ts`：带 scope/provenance/expiry 的 Self/Person/Group/World 只读 hypothesis projection（Goal/Debt 仍由 workspace 的专门 store 提供）。
- `src/tracking/relationship.ts`：实时关系快照与 0105 历史 revision 读取；`getRelationshipAt` 只读锚点前状态并按锚点时间衰减。
- `src/agent/cognitive-debts.ts`：`findRelatedDebtsScoped` 提供带命中原因的确定性 scope/source/text matcher；`findRelatedDebtsScopedWithSemantic` 允许 host 注入有界 scorer，不改变 debt 状态。
- `src/agent/social-event-graph.ts`：从 metadata-only `social_interaction` 事件构建有界、可按 chat/user/as-of 回放的有向时间衰减图，并提供冲突→修复→后续互动的 replay-only 评估；不承担长期关系推断或社交策略。
- `src/agent/social-predictions.ts`：显式开关下记录 engagement expectation、按真实互动/沉默结算 prediction error，并提供 calibration；不修改关系、规范、prompt 或策略。
- `src/agent/cognitive-workspace.ts`：在既有 workspace opt-in 下暴露 bounded social graph 只读部分，沿用同 chat/as-of 边界。
- `src/agent/cognitive-routing.ts`：纯函数复杂度触发器和 `fast/deep/background` 路由决策；`cognitive-route-observations.ts` 持久化真实 Reply 回合的成本/质量窗口，但不拥有执行权限。
- `src/agent/replay.ts`：固定输入、事件回放、projection 对比和失败重现。
- `src/eval/agi-like-evaluator.ts`：paired replay 的 legacy/core、memory/skill/prediction ablation 和基础运营指标；`scripts/eval-long-horizon-live.ts` + `src/eval/long-horizon.ts` 已提供真实 provider/CodeAct host 的小规模 long-horizon execution window，social、crash/restart、interrupt 和更广 safety 指标仍需真实实验接入。
- `src/sandbox/capability-check.ts`：隔离、网络、资源、挂载和启动自检。

现有模块的迁移原则：先加 facade 和 adapter，再替换调用方；不要一次性删除 legacy reply、Heart、Meta 或 CodeAct。

## 7. 发布开关和灰度

建议增加以下运行开关，所有开关都必须支持按 chat 灰度：

```text
COGNITIVE_EVENTS_ENABLED
COGNITIVE_OUTBOX_ENABLED
COGNITIVE_WORKSPACE_V2_ENABLED
AGENCY_RUNTIME_MODE=shadow|advisory|canary|authority
AGENCY_CANARY_CHAT_IDS
AGENCY_MAX_LLM_CALLS
AGENCY_MAX_TOOL_CALLS
AGENCY_FAIL_CLOSED
AGENCY_LEGACY_REPLY_OBSERVATION_ENABLED
SANDBOX_REQUIRE_ISOLATION
DEBT_AUTO_MATCH_ENABLED
DEBT_AUTO_REPAY_ENABLED
PREDICTION_UPDATE_ENABLED
WORLD_MODEL_PROJECTION_ENABLED
SKILL_PROMOTION_MODE=human|verified_canary
REPLAY_EVAL_ENABLED
```

灰度阶段：

1. **Offline**：migration、unit、replay、security 和 holdout，不连接 Telegram 副作用。
2. **Shadow**：记录 Core/workspace/action proposal，不改变用户行为。
3. **Advisory**：Core 给 legacy 提供建议，只读动作可观测，仍不改变副作用。
4. **Canary**：一个内部群接管低风险动作；不可逆动作保持人工确认。
5. **Limited authority**：扩大到少量稳定群，持续 paired evaluation。
6. **Default**：只有连续窗口满足可靠性、隐私、安全、成本和长期指标后才扩大。

立即回滚条件：

- 任何跨 chat/user visibility violation。
- event、receipt 或 action duplicate 无法幂等消除。
- sandbox 隔离失败仍可执行宿主命令。
- false success、错误主动联系或不可逆副作用超过 canary 阈值。
- event loss、queue lag、模型调用成本或延迟超出预算。

回滚只切换运行模式和 adapter，不删除事件、receipt、evidence 或历史 skill revision。

## 8. 测试矩阵

### 8.1 单元测试

- scope 组合、visibility、expiry、superseded、contradiction。
- event schema、dedupe、sequence、correlation、redaction。
- action validation、risk classification、budget、idempotency、cancel。
- debt matching、resolution、reopen、snooze、expiry。
- prediction scale、calibration、feedback attribution、minimum evidence。
- skill artifact、negative checks、publish/rollback。
- sandbox command policy、bwrap capability check、fail-closed。

### 8.2 集成测试

- Telegram update -> event -> workspace -> action -> delivery -> feedback -> projection。
- CodeAct checkpoint -> interrupt -> restart -> resume -> acceptance -> goal/debt settle。
- Core shadow/advisory/canary/authority 与 legacy fallback 切换。
- Redis 重复消息、SQLite transaction failure、outbox retry 和进程崩溃。
- 同 uid 多群、匿名用户、DM/group、跨群 forward 和主人权限。

### 8.3 回放和长时测试

- 1 天和 7 天真实历史切片回放。
- 多步工具任务中间失败后换路线。
- 用户纠正、目标变更、停止、澄清、部分交付。
- world fact 更新、冲突、过期、撤销和新证据覆盖。
- memory/skill/prediction ON/OFF 成对实验。

### 8.4 安全测试

- bwrap 不存在、user namespace 禁用、网络 namespace 失败、挂载失败。
- 读取 `.env`、访问其他 chat 数据、路径 traversal、symlink、命令变体。
- 恶意或越权 action envelope、重放旧 intent、修改 caller evidence。
- LLM 输出伪造 `source: caller`、`verified`、权限或跨群 chat id。

## 9. 指标和最低验收口径

在没有稳定 baseline 前，不设“AGI 分数”，先记录并比较以下事实：

- **持续性**：目标、纠正、债务、未决问题在 1 天/7 天后的保留和正确处理率。
- **可靠性**：host-verified success、false success、部分交付、repair、人工介入和恢复时间。
- **学习**：ON/OFF 差异、prediction calibration、重复错误率、skill 迁移成功率。
- **社会**：不必要插话、打扰、误认身份、社交修复和跨群泄漏。
- **安全**：scope violation=0、未经授权副作用=0、隔离失败宿主执行=0、不可解释的 duplicate action=0。
- **运营**：P95 延迟、每条消息 LLM/tool calls、token 成本、队列延迟、事件丢失和回滚次数。

任何报告必须同时包含：代码版本、配置快照、样本数、时间范围、实验组、失败样本和不确定性。没有这些字段时只能称为 smoke test 或 engineering check。

## 10. 交付顺序

建议按以下纵向切片提交，不要按“再加一个智能模块”的方式零散推进：

### Slice A: Scope + safety + event foundation

- 修复 belief/world/debt/tool scope。
- 新增 `cognitive_events` 和 outbox。
- bwrap/容器 fail-closed 和 capability check。
- 建立 cross-chat、crash/restart、redaction 回放测试。

### Slice B: Workspace + correlation

- workspace v2 覆盖 reply、Heart、Meta、CodeAct、unified tick。
- 统一 provenance、uncertainty、task evidence、goal/debt 注入。
- 全链路 `correlationId`、`causationId`、receipt。

### Slice C: Agency canary

- dispatcher 和 host policy。
- 先接管 observe/wait/remember/只读工具，再接管可逆动作。
- 保留 legacy adapter 和一键 shadow 回退。

### Slice D: Debt + prediction learning

- 自动 debt detection/matching/repayment。
- 统一 prediction scale，接通真实 outcome 和校准。
- 多证据更新 Self/Person/Group/skill policy。

### Slice E: Generalization + skill promotion

- 多领域 holdout、long-horizon replay、external acceptance。
- skill artifact、测试、灰度发布和 rollback。
- 安全 self-edit candidate pipeline。

### Slice F: Social model + cost optimization

- group event graph、social prediction error、repair evaluation、Group norm as-of revision 和 Person relationship as-of revision 的 metadata/replay 基础已完成（0102–0105 + `social-event-graph`/`social-predictions`/`group-norms`/`relationship`）；关系/群规范自动更新与更完整的长期 hypothesis 学习仍待后续阶段。
- fast/deep/background routing 的确定性 shadow 基础、Reply scoped-workspace、deep grounding 专家和统一唤醒 background route 元数据/工作区切片已完成；0106 已提供按真实 Reply 回合记录的 route/score/行为门、延迟、工具调用、回复数和用户反馈窗口；仍需收敛 multi-agent 成本并做真实质量窗口验收。
- 完成 paired evaluation 和持续运营报告。

## 11. Definition of Done

本计划完成的标准不是“所有模块都存在”，而是：

- 普通消息和深路径消息都有明确的 event、workspace、action、outcome 语义。
- 任何 belief、debt、prediction、goal、skill 都可追溯到来源、范围、时间和证据。
- Core 能在 canary 范围内真实接管低风险动作，并能安全回退 legacy。
- 任务成功由外部验收或 host observation 决定，模型不能自证成功。
- 中断、重启、工具失败、目标变更和用户纠正能被回放并恢复。
- memory/skill/prediction 的收益有 held-out ON/OFF 证据。
- self-improvement 经过独立验证、灰度和 rollback。
- sandbox、scope、幂等和副作用检查满足零违规发布门槛。
- latency、token、队列和后台任务在长期运行预算内。
- 文档、配置、migration、runbook 和指标与实际代码一致。

## 12. 第一批实施任务

开工时按这个顺序创建 issue/PR：

1. `AGI-001`：Core belief/world/debt 全路径 scope 修复和跨群回归测试（基础已完成）。
2. `AGI-002`：sandbox capability check，隔离失败 fail-closed，修复 bwrap 部署检查（基础已完成）。
3. `AGI-003`：`0089_cognitive_events` + append/dedupe/replay API（基础已完成）。
4. `AGI-004`：outbox、correlation id 和 task runtime event 持久化消费者（基础已完成，tool 与 model-turn started/finished 事实和确定性 tool callback projection 已接入）。
5. `AGI-005`：workspace v2 facade，接入 Reply、Heart、Meta、CodeAct 和 unified tick（opt-in 已完成）。
6. `AGI-006`：AgencyAction envelope、host policy、attempt/receipt、usage meter、Core proposal shadow bridge、readonly intent adapter、显式 `speak/ask/wait/act/observe/remember/correct/stop` adapter factories、默认关闭的 legacy Reply observed-delivery bridge、Meta dispatch observation bridge 和 authority-only Reply/wait/Meta CodeAct transport（runtime/readonly bridge/观测桥/adapter contracts/Reply、wait、CodeAct wiring、Meta dispatch decision facts 与 durable event causation 已完成；其它 Meta 动作注册、canary/authority 验收仍待后续）。
7. `AGI-007`：evidence-only debt resolution、matcher 和 prediction calibration（有界 revision ledger 已完成，semantic/长期学习和长期假设更新待补）。
8. `AGI-008`：paired replay/holdout runner 与长期指标报告（paired replay 基础和首个 5 例真实 holdout/long-horizon window 已完成；首轮 `2/5`、`40%`，仍需重复窗口、扩大任务域并接入 crash/restart、interrupt 和 external acceptance）。

在 `AGI-001`、`AGI-002`、`AGI-003` 没有通过前，不打开 Core authority、自动债务偿还、自动 skill promotion 或更宽的 CodeAct 权限。
