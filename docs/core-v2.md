# Core v2 总览

> 状态：Phase 0–4 + AGI-like foundation/held-out execution slice 已上线（v0.5.x）；paired replay、真实 long-horizon 窗口、Agency canary harness 和 evidence-gated hypothesis audit 已加入。真实 Telegram canary、authority 开启、merge/restart 仍关闭并需人类操作。

## 一句话

Core v2 是 bot 的第二套认知地基：**belief（信念）管"记得什么"，drives（驱动）管"想做什么"，lifecycle（门）管"技能怎么长出来"**。旧系统（profiles/norms/goals/skills 表 + unified-tick）继续当**事实来源和 legacy 执行器**；Core/Agency 只有在显式 adapter、scope 和权限检查后才可运行，默认仍是 shadow/advisory。

## 架构（Core 只建议/否决；Agency 由 host 显式执行）

```
旧系统（真相 + 执行，全部保留）
  user_profiles / person_identity / group_norms / goals / world_entities / skills
  unified-tick（cron ticker） / pipeline judge / subagent executor
        │ 双写（fire-and-forget，失败只打日志）
        ▼
Core v2（读投影 + 策略）
  core_beliefs        ← 5 张旧表的统一读视图（Phase 2）
  core_drives         ← connection/curiosity/competence/autonomy（Phase 3）
  core_blackboard     ← L0/L1/proposal 留痕 + L2 快照隔离（Phase 0/1）
  core_skill_lifecycle← skill 的门：propose→verify→approve→publish（Phase 4）
  cognitive_events/outbox ← 可去重、可回放的感知与 runtime 生命周期
  cognitive-outbox-worker/projector ← 显式启动的租约消费与确定性投影
  world-projection ← 统一 Self/Person/Group/World scoped hypothesis facade
  agency_runs          ← envelope/幂等/预算/取消/adapter 执行状态；Core proposal shadow run
  agency_attempts/receipts ← 每次尝试和执行结果的 durable 事实
  world_entity_revisions / skill_revisions ← 历史版本与回滚账本（窄切片 projection/lifecycle 已接线）
  social_interaction events / social-event-graph ← 可回放的有向互动事实与有界衰减图（只读 foundation）
  cognitive-routing / route-observations ← 目标/债务/工具/风险等确定性复杂度触发器与真实 Reply 成本/质量窗口（不拥有执行权限）
  replay_experiments ← paired replay 的实验元数据与样本指标
  agency_action_semantics / hypothesis_update_audit ← host-derived action anchors 与 Self/Person/Group/World 证据门审计
```

铁律（所有 phase 通用）：

1. **不重构旧表，只加薄基础设施**——新表全是增量 migration；必要的 scope/provenance 兼容列只追加、不改写历史语义。
2. **置信度/状态只由 host 可验证 outcome 更新**——LLM 提供内容，host 推状态。LLM 自己批不了自己。
3. **未知/失败一律 fail-soft**——双写失败不拦旧路，suppressor 抛错不拦 tick，prompt 组装抛错则逐字节回退；副作用路径仍 fail-closed。
4. **作用域不可省略**——chat/user/task 事实必须带 scope key，legacy 模糊行不进入 scoped workspace。
5. **隔离失败不回退宿主**——`SANDBOX_REQUIRE_ISOLATION=true` 时 bwrap 不可用直接拒绝终端执行。
6. **总开关**：`CORE_V2_ENABLED=false` 一刀切（shadow 零开销）；`CORE_DUAL_WRITE=false` 停更 belief。
7. **事件消费者显式受控**——库层不隐式启动；scheduler 只有在 `COGNITIVE_OUTBOX_ENABLED=true` 时注册 projector，债务创建还需单独打开 `DEBT_AUTO_MATCH_ENABLED`；worker 失败只进入 retry/failed，不触发副作用。

## Phase 谱系（commit 可查）

| Phase            | 落点            | 表                                                                                                                                                                                                                                                                                                                                   | 做了什么                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0 地基           | `a8d8912` (#70) | 0083 `core_beliefs`（实际叫 core_belief_view 相关）、0084 `core_blackboard`                                                                                                                                                                                                                                                          | belief store + Laplace 置信度 + 矛盾检测 + 黑板 ACL + permission gate + 快照隔离 + eval harness（`scripts/eval-belief-view.ts`，离线独立实现）                                                                                                                                                                                                                                                                                                                                            |
| 1 分层           | `83666b0` (#71) | —                                                                                                                                                                                                                                                                                                                                    | `runCoreTick`（L0 复用 l0Rule / L1 复用 microJudge / L2 全 dry-run）+ `assembleState` + `assembleSystemPrompt` + pipeline shadow 钩子（只记 `core shadow compare` 日志，不改行为）                                                                                                                                                                                                                                                                                                        |
| 全开             | `ed8b64` (#72)  | —                                                                                                                                                                                                                                                                                                                                    | `isCoreChat` 空名单=全量（与 TURN_ACTOR 一致）；`CORE_V2_ENABLED` 总开关                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 2 迁移           | `dbcab32` (#73) | —（复用旧表）                                                                                                                                                                                                                                                                                                                        | `src/core/migrate.ts`：5 张旧表→belief 双写（`CORE_DUAL_WRITE`）；L1 的 judge 请求带 `[当前信念]` 段（≤`BELIEF_VIEW_INJECT_MAX`=4）                                                                                                                                                                                                                                                                                                                                                       |
| 3 驱动           | `a5f124f` (#74) | 0085 `core_drives`                                                                                                                                                                                                                                                                                                                   | `deriveDriveValues` + `proposeActions`（候选动作）+ tick prompt 拼增益排序 + `suppress`（satiation≥0.5 否决）+ 执行后 `satiate`                                                                                                                                                                                                                                                                                                                                                           |
| 4 技能门         | `05af8e4` (#75) | 0086 `core_skill_lifecycle`                                                                                                                                                                                                                                                                                                          | propose→verify（红线+去重）→approve（人审唯一门）→publish（调旧 saveSkill）；`pruneExpiredProposals`（30d）                                                                                                                                                                                                                                                                                                                                                                               |
| foundation slice | 2026-09-12      | 0089–0109 `cognitive_events` / outbox / scope / debt provenance+history / `agency_runs` / attempts+receipts / world+skill history / prediction dimensions+revision ledger / social event graph+prediction ledger / group norm+relationship revisions / route observations / replay experiments / action semantics / hypothesis audit | Core/world scope、事件 append/dedupe/replay、outbox worker/projector、task runtime durable facts、sandbox fail-closed、Reply/Heart/Meta/CodeAct/unified tick workspace projections、Agency usage meter、paired replay ablation evaluator、真实 held-out long-horizon runner、metadata-only social interaction replay、社会预测误差与修复评估、Group/Person hypothesis as-of 回放、Reply 路由成本/质量窗口、统一 action anchor 和 evidence-gated hypothesis audit；authority/canary 仍关闭 |

## 表语义速查

**core_beliefs**：`(source_table, source_row_id, predicate, scope_key)` 唯一——同一 scope 内更新 summary，不插新行、不重置 confidence。新 belief confidence=0.5（Laplace 先验），靠 `recordOutcome` 的 host-verified support/refute 收敛。无 evidence 不落库（`upsertBelief` 直接抛错）。未完成迁移的 legacy 行只保留兼容读取，不进入 scoped workspace。

- predicate 映射：`group.norm`（group_norms，按 chat）/ `person.interest`（user_profiles，按 chat+uid）/ `person.trait`（person_identity，按 uid）/ `entity.status`（world_entities，按 scope）/ `goal.state`（仅 active goals，按 chat/global）。
- 刻意不进的：world_entities 里 1900+ 条 topic 回复指令是噪音（`syncWorldEntity` 只在 upsert 时同步单条，历史噪音不回填）。

**core_drives**：value 由 tick 每轮 `deriveDriveValues` 重算并 `setDriveValue`；satiation 由执行后 `satiate(name)` 置 1，半衰期 6h 指数衰减（`CORE_DRIVE_SATIATION_HALFLIFE_SEC` 可配）。suppressor 只看 satiation 不看 value；quiet 永不拦。

**core_blackboard**：kind = observation（L0 留痕）/ proposal（L1 "我建议回/不回，因为…"，L2 可执行的 plan 永不直接写）/ snapshot（L2 开工冻结）。读走 `visibleToL1`（contradicted 不可见）。

**core_skill_lifecycle / skill_revisions**：published 之前 skill 永不进 `findRelevantSkills`（查不到=用不上）。每次 propose/version 形成独立 revision，状态推进到 verified/approved/published；`verifySkill` 会把 host 静态检查结果以 bounded `test_summary` 写入 revision（不保存额外 artifact 正文），失败也留审计原因；`listSkillRevisionVerificationSummaries` 和 `GET /monitor/api/skill-verifications` 只投影状态、验证器、检查项名称与通过/失败计数，解析异常降为 `unknown`，不暴露 artifact、步骤、检查原因或回滚文本。这不是 held-out 行为验证，发布仍必须经过主人 `approve`。host-only rollback 会保留原因、归档当前 artifact，并在存在时恢复最近上一版 published revision。`reviewer` 是主人 uid，`/skill pending|verify|approve|publish|reject` 已通过 pipeline 的 host intercept 接线，并且只允许主人 DM；剩余尾巴是更丰富的 review diff/UI、负例/回归测试和审批审计，不是命令未接线。

**cognitive_events / outbox**：事件是 append-only、带 scope/correlation/dedupe 的 host 事实；outbox worker 负责租约、重试和显式 ack。CodeAct queue 在 BullMQ 或本地 fallback 接受任务后记录 `task_queued`，主循环记录不含模型正文的 `model_turn_started`/`model_turn_finished` 边界，host wrapper 再记录不含参数/正文的 tool started/finished 对；`getTaskRecoverySummary` 可在重启后把 task correlation 与 `task_evidence` 聚合为不含正文的 lifecycle/acceptance/recovery summary，`GET /monitor/api/task-recovery` 只读返回状态、checkpoint、计数和安全 reason code，不暴露任务方向、模型输出、resolution 或工具参数。`GET /monitor/api/skill-verifications` 同样只返回 revision 验证 lineage 的 bounded metadata，供 release/evaluation window 使用，不改变 skill 发布或执行权限。现有群组 reply-chain 旁路记录 metadata-only `social_interaction`，`social-event-graph` 可按 chat/user/as-of 读取并构建有向、时间衰减的有界图，不保留正文或跨群身份。opt-in cognitive workspace 会把同一 chat 的 bounded social graph 作为带免责声明的只读部分暴露给调用方；它不授予动作权限，也不跨 scope 合并身份。`social_predictions`（0103）在显式 `SOCIAL_PREDICTION_ENABLED` 下记录群投递后的 engagement expectation，只由目标用户的真实 reply/reaction/conflict/repair 事件或观察窗沉默结算，保存 signed prediction error 和 outcome event；`evaluateSocialRepairs` 只读评估冲突→修复→后续互动，不直接改变关系或回复策略。`cognitive-route-observations`（0106）只对实际进入 Reply generation 的路由样本记录 route/score/行为门，并由 delivery/outcome 回填终态、延迟、工具/回复计数和用户正负反馈；monitor token API 的 `GET /monitor/api/route-observations` 提供有界的 chat/since/limit 聚合查询。它是 guarded telemetry，不改变路由、权限或发送副作用。`cognitive-projector` 当前处理 host-observable prediction feedback、带来源事件的债务创建/证据偿还、成功 tool callback 的确定性 debt resolution，以及严格 chat scope 的 `world_change` 到 entity revision 投影。`findRelatedDebtsScoped` 先按 task/user/chat/source-event anchor 做确定性匹配，再在有界候选集上做文本 overlap；它只排序 workspace 展示，不自动偿还。`world-projection` 再把现有 Self/Person/Group/World tracking 行收敛成带 provenance/expiry 的只读 hypothesis，供 workspace 复用；它仍不是完整的长期模型更新器。

**cognitive_debt_revisions**：债务创建和状态/证据/expiry 更新由 SQLite trigger 写入 append-only 快照。事件锚点读取选择 `snapshot_at <= occurredAt` 的最新 revision，并按 scope、expiry 和 open 状态过滤；迁移前旧行标为 `legacy=1`，无法支持更早时间点的假设性回放。

**prediction calibration**：`bot_predictions` 在 0100 增加 `user_id`/`action_type` 维度；0101 的 `prediction_model_revisions` 在同一 chat/user/action 至少有 3 条 resolved host outcome 后追加一条有界 EMA 修订，保留 source prediction/outcome event、样本数和前后 bias。该表是 append-only 审计输入，当前不自动改 prompt、skill、policy 或 belief；旧库缺少新列/表时仍保持原预测回填兼容。

**social event graph**：0102 只增加 `social_interaction` 事件索引；`recordSocialInteraction` 对 reply/mention/reaction/support/conflict/repair 做正整数用户、chat scope、dedupe 和 bounded fact 校验，`buildSocialGraph` 以 event `occurredAt` 做时间衰减并保留有向边和互动类型。0103 的 `social_predictions` 在显式开关下为真实群投递建立 engagement 先验，按目标用户的后续互动结算误差，超出观察窗则记录 silence；`summarizeSocialPredictionCalibration` 只输出 bounded host outcomes。0104 为 `group_norms` 保留 append-only revision，`getGroupNorms(chatId, asOf)` 可在事件锚点读取历史规范；0105 为 `chat_relationships` 保留 append-only revision，`getRelationshipAt(chatId, uid, asOf)` 按锚点读取关系并以锚点时间做衰减，Person 投影不再读取未来的可变关系行。现有 feedback host hook 将用户对 bot 的 reaction 映射为 support/conflict，将纠正 follow-up 映射为 repair，其余 follow-up 记为 reply；`evaluateSocialRepairs` 对冲突后修复和后续互动做 replay-only 指标。桥接失败不影响 feedback 主闭环；这些数据是 replay/evaluation 输入，不等同于 Person/Group 长期关系模型，也不会改变当前回复选择。

**agency_runs / attempts / receipts**：run 保存 envelope 生命周期，attempt 保存每次 claim/settle，receipt 保存 succeeded/failed/cancelled/expired 结果；LLM/tool usage meter 在 adapter 内可消费并硬性拒绝超预算。Core L1 proposal 现在会以无副作用 `observe` action 写入 durable run，并带稳定幂等键；默认 `AGENCY_RUNTIME_MODE=shadow` 时由 policy 转成 `waiting`，不会发送消息或执行工具。原有 permission gate 打开时，readonly authorized intent 也可经 Agency policy/预算/receipt 执行，写类仍走旧 gate。`agency-control-adapters.ts` 提供显式 `observe/remember/correct/stop` host callback 工厂：`correct` 必须由 host 返回 `resolved=true` 和 evidence event id，不能只凭模型文本结算。`createAgencyDeliveryAdapters` 提供显式 `speak/ask` host adapter 工厂，`createTelegramAgencyDeliveryAdapters` 是延迟加载现有 Telegram sender 的绑定点；`createAgencyWaitAdapters` 提供同样约束的 `wait` scheduler 工厂，`createTimingAgencyWaitAdapters` 可显式绑定现有 WAIT/恢复 FSM；`createAgencyActAdapters` 提供显式 CodeAct task/queue host contract，`createCodeActAgencyActAdapters` 延迟绑定现有 CodeAct queue，只有 host 返回 durable `taskId` 和 `acceptedAt` 才算接受。四类 adapter request 都透传完整 `CognitiveScope`（而不是只传 chat id），让 task/user-scoped host 能在副作用前二次校验；发送/调度/写入/排队函数和幂等元数据由调用方注入。Reply、wait、CodeAct authority envelope 以及 legacy delivery observation 都优先使用原始 Telegram/cognitive event 作为 `causationId`；task runtime 的 queue/start/tool/delivery/wait/terminal lifecycle 也把任务锚点写入 durable event，重启 replay 会还原该关联，缺少锚点时才保留兼容性的 task/Telegram fallback。Meta 的 CodeAct 入队已提供 `AGENCY_CODEACT_TRANSPORT_ENABLED` authority-only wiring；`dispatch.taskToGroup`、`journal.tryWrite`、`journal.recent`、`todo.add/list/remove`、`agents.listStatus`、`conversations.query` 和 `memory.searchEntities` 均通过 metadata-only action registry 使用统一 `anchor/trigger/obligation` 语义，真实 queue/发送仍由 legacy/host authority 持有；`GET /monitor/api/agency-runs` 只提供脱敏 run lifecycle summary。Reply 文本段另有 `AGENCY_REPLY_TRANSPORT_ENABLED` authority-only wiring，先落 durable `speak` run，再以 Telegram 返回真实 `messageId` 结算；该模式关闭 ack、贴纸、投票、reaction、voice 和 humanizer 二次发送/编辑，失败不回退 legacy，默认仍关闭。Heart、Meta Heart、Meta timing/dispatch gate 与 pipeline gate 的 wait 也有 `AGENCY_WAIT_TRANSPORT_ENABLED` authority-only wiring：先保留 replay anchor，再由 timing FSM 返回真实 `waitUntil/waitJobId`，失败不调用 legacy `transitionToWait`，默认仍关闭。`src/eval/agency-canary.ts` 提供 frozen baseline/experiment、Wilson CI、rollback threshold 评估，真实群 canary 和 authority 仍按 runbook 由人类开启。policy 会从 action 重新推导风险，错误的 `risk` 标记直接拒绝，不能把不可逆动作降级成 read。`AGENCY_LEGACY_REPLY_OBSERVATION_ENABLED=true` 时，未开启 authority transport 的 Reply 在确认 Telegram 已返回真实 `messageId` 后才创建并结算一个 observed speak run；该桥不 dispatch、不重发，按触发消息和消息 id 幂等，默认关闭。

**replay_experiments**：`runPairedReplayEvaluation` 先固定同一 correlation 的事件切片，再给每个变体同一只读、冻结事件数组；状态、false-success、人工介入、修复、延迟和调用成本按变体聚合，并提供 Wilson 95% 区间。报告还会固定 `evidence`（代码版本、白名单配置快照、样本数、事件时间范围、实验组、受限失败样本和 uncertainty）；缺字段会显式标记，不能把工程检查误报成 AGI 分数。真实执行器、验收合约和 held-out 样本仍由调用方负责。

**world_entity_revisions**：`world_entities` 只保存当前快照，revision 表保存带 `source_event_id`、confidence、expiry 和 superseded 状态的 append-only 历史；同一来源事件幂等，过期快照不进入当前查询但历史仍可审计。

**world-projection**：以 workspace 的 task/chat/user scope 为边界，读取 self notes、当前群用户画像、群规范、关系 revision 和 world entity snapshot；输出统一的 `self/person/group/world` hypothesis 清单。过期画像/规范会降为 `stale` 并进入 uncertainty，跨 chat 的 profile/entity 行直接丢弃；事件锚点会选择 Group/Person 的历史 revision，缺少历史时显式声明 uncertainty。该层只读，不把 LLM 摘要升级为 verified belief，也不授予 Agency 权限。

**事件锚点**：workspace 的 `asOfEventId` 必须属于同一 chat（chat scope 也不能指向另一 task），并以事件 `occurredAt` 作为读取时钟。可追溯的 belief、goal、prediction、task evidence、legacy task 和 Self/Person/Group 行按时间过滤；World 从 `world_entity_revisions`、债务从 `cognitive_debt_revisions` 选择锚点前最近 revision。迁移前旧债务只有 `legacy=1` 的当前快照，无法推断其更早状态，workspace 会标注这一限制。

## Env 旗（全在 `src/env.ts`，CORE_ 前缀）

| 旗                                                                 | 默认        | 关掉会怎样                                                                                                    |
| ------------------------------------------------------------------ | ----------- | ------------------------------------------------------------------------------------------------------------- |
| `CORE_V2_ENABLED`                                                  | true        | isCoreChat 全 false，shadow 零开销                                                                            |
| `CORE_V2_CHAT_IDS`                                                 | 空=全量     | 非空则只对名单群生效                                                                                          |
| `CORE_DUAL_WRITE`                                                  | true        | core_beliefs 停更，读侧照常                                                                                   |
| `CORE_BELIEF_VIEW_ENABLED`                                         | true        | assembleState 不读 belief                                                                                     |
| `CORE_BLACKBOARD_ENABLED`                                          | true        | 黑板不写                                                                                                      |
| `CORE_PERMISSION_GATE_ENABLED`                                     | false       | L2 真执行门（Phase 2 没开，因为 L2 全 dry-run；开真执行那天再开）                                             |
| `AGENCY_RUNTIME_MODE`                                              | `shadow`    | Agency host 闸：`shadow`/`advisory` 只观察，`canary` 只放白名单群低风险动作，`authority` 才放不可逆动作       |
| `AGENCY_CANARY_CHAT_IDS`                                           | 空          | `canary` 模式允许 dispatch 的 chat id；空名单在 canary 下全部拒绝                                             |
| `AGENCY_MAX_LLM_CALLS` / `AGENCY_MAX_TOOL_CALLS`                   | 2 / 8       | 单个 Agency envelope 的硬预算上限                                                                             |
| `AGENCY_FAIL_CLOSED`                                               | true        | policy 或执行能力不明确时拒绝 dispatch                                                                        |
| `AGENCY_CODEACT_TRANSPORT_ENABLED`                                 | false       | 仅在 `authority` 下让 Meta CodeAct 入队走 Agency；失败不绕过策略回退 legacy                                   |
| `AGENCY_REPLY_TRANSPORT_ENABLED`                                   | false       | 仅在 `authority` 下让 Reply 文本段走 durable Agency `speak`；失败不回退 legacy，并关闭 ancillary side effects |
| `AGENCY_WAIT_TRANSPORT_ENABLED`                                    | false       | 仅在 `authority` 下让 Heart/Meta/pipeline wait 走 durable Agency `wait`；失败不回退 legacy transition         |
| `SOCIAL_PREDICTION_ENABLED`                                        | false       | 记录群互动先验、host 事实结算和沉默过期；只写 metadata，不改变回复策略                                        |
| `AGENCY_LEGACY_REPLY_OBSERVATION_ENABLED`                          | false       | 只记录 legacy Reply 的真实投递结果，不注册 Agency transport、不改变发送                                       |
| `AGENCY_CODEACT_TRANSPORT_ENABLED`                                 | false       | 仅在 `authority` 下让 Meta CodeAct 入队走 durable Agency；失败不绕过 policy                                   |
| `AGENCY_REPLY_TRANSPORT_ENABLED`                                   | false       | 仅在 `authority` 下让 Reply 文本走 durable Agency `speak`；失败不回退 legacy                                  |
| `AGENCY_WAIT_TRANSPORT_ENABLED`                                    | false       | 仅在 `authority` 下让 Heart/Meta/pipeline wait 走 durable Agency `wait`；失败不回退 legacy                    |
| `COGNITIVE_EVENTS_ENABLED`                                         | true        | 事件 append/outbox/runtime 持久化；紧急回滚可关闭                                                             |
| `COGNITIVE_OUTBOX_ENABLED`                                         | true        | 事件 outbox 投递；projection 故障时可单独暂停                                                                 |
| `COGNITIVE_WORKSPACE_V2_ENABLED`                                   | false       | legacy reply 组装统一 scoped workspace；关闭时保持快路径                                                      |
| `COGNITIVE_ROUTING_ENABLED`                                        | false       | 记录 `fast/deep/background` 复杂度路由 shadow 指标；关闭时不做额外分类                                        |
| `COGNITIVE_ROUTING_BEHAVIOR_ENABLED`                               | false       | 仅允许非 fast 路由按灰度群复用 scoped workspace；不授予 Agency 权限、不增加发送副作用                         |
| `COGNITIVE_ROUTING_CHAT_IDS`                                       | 空=全量     | 路由行为灰度群；非空时只对名单 chat 生效                                                                      |
| `MULTI_AGENT_ROUTE_CONVERGENCE_ENABLED`                            | false       | 仅在显式 chat allowlist 内按 fast/deep/lookup 路由收敛 specialist fan-out；不授予 Agency 权限                 |
| `MULTI_AGENT_ROUTE_CHAT_IDS`                                       | 空          | route convergence 的 chat allowlist；空名单不启用灰度                                                         |
| `DEBT_AUTO_MATCH_ENABLED`                                          | false       | outbox projector 是否创建确定性认知债务；不影响 prediction 回填                                               |
| `DEBT_SEMANTIC_MATCH_ENABLED`                                      | false       | 在确定性候选后启用 host-owned bounded semantic ranking；不自动偿还债务                                        |
| `DEBT_SEMANTIC_MATCH_USAGE` / `DEBT_SEMANTIC_MATCH_MAX_CANDIDATES` | `judge` / 4 | semantic scorer 的 usage 和候选上限                                                                           |
| `DEBT_SEMANTIC_MATCH_MIN_SCORE` / `DEBT_SEMANTIC_MATCH_TIMEOUT_MS` | 0.72 / 2500 | 低于阈值丢弃，超时 fail-soft                                                                                  |
| `GROUP_NORMS_AUTO_UPDATE_ENABLED`                                  | false       | 模型群规范只写 candidate/read-only audit；只有 host evidence gate 能写 active norm                            |
| `SANDBOX_REQUIRE_ISOLATION`                                        | true        | bwrap/隔离不可用时拒绝终端执行；false 仅应急允许宿主回退                                                      |
| `BELIEF_VIEW_INJECT_MAX`                                           | 4           | prompt 里 `[当前信念]` 上限                                                                                   |
| `CORE_DRIVE_SATIATION_HALFLIFE_SEC`                                | 21600       | satiation 半衰期（store 里读 `process.env` 直值，防循环依赖——改 env.ts 时注意这一处是直读）                   |

## 验收口径（怎么知道它还活着）

- `grep -a -c "core shadow compare" logs/app.log` —— 每条 L0-miss 消息一条，有 `agree:true/false`（core vs legacy 动作对比）。
- `SELECT name, value, satiation FROM core_drives` —— tick 每 5 分钟重写 value；satiation=1 说明刚执行过同类动作。
- `grep -a "vetoed by drive satiation" logs/app.log` —— suppressor 开张记录（Phase 3 的"连续 3 天不刷屏"从这里看）。
- `SELECT status, COUNT(*) FROM core_skill_lifecycle GROUP BY 1` —— 门里的候选数。
- `npx tsx scripts/eval-belief-view.ts` —— 离线 harness（毒化/ttl/越权/P99），exit 0 为过。

## 已知的尾巴（下次开工从这里起）

1. **skill review UI 仍偏薄**：`/skill pending|verify|approve|publish|reject` 已接入主人 DM 的 host 命令，后续可补 callback 按钮、revision diff 和更完整的审批审计；本轮不把 skill 静态 verification 当作 held-out 行为收益。
2. **`CORE_PERMISSION_GATE_ENABLED` 没开**：L2 还是全 dry-run。开真执行 = Phase 5（gate 接 promote.ts 的 authorized_intent）。
3. **L1 的 `[当前信念]` 让 shadow 不再是同 prompt 对比**：agree 只比 action，prompt diverged 是已知的、可接受的。如果哪天 agree 率掉了，先看是不是 belief 段带偏了 microJudge。
4. **`halflifeSec()` 直读 `process.env`**（store.ts）：当时为防循环依赖。改 env.ts 相关逻辑时别漏这一处。
5. **旧 profile belief 仍可能是 legacy scope**：新 profile 刷新会按 chat+uid 双写；历史合并行不会自动猜测归属，需自然刷新或专项 backfill 后才进入 scoped workspace。
6. **Agency runtime 仍默认不接管生产主路径**：Reply 文本和 Heart/Meta/pipeline wait 已有默认关闭的 authority bridge（`AGENCY_REPLY_TRANSPORT_ENABLED`、`AGENCY_WAIT_TRANSPORT_ENABLED`），分别以真实 Telegram `messageId`、timing `waitUntil/waitJobId` 作为成功条件，并在失败时禁止 legacy fallback；Meta 的 action registry 已统一 anchor/trigger/obligation 并记录 metadata-only facts，真实 queue/发送仍由 legacy/host authority 持有。`src/eval/agency-canary.ts` 和 runbook 已准备 frozen baseline、实验组、回滚条件和报告模板；真实群 canary、authority 开启和生产操作仍需人类验收。
7. **事件投影仍是窄切片**：当前自动回填可观察 prediction feedback、创建带 source event 的债务、处理成功 tool callback 的确定性偿还，并把严格 scope 的 `world_change` 写入 entity revision；prediction calibration revision ledger 只记录达到证据门槛后的有界修订，不驱动运行时策略。`social_interaction` 已有 metadata-only 可回放事件图，`SOCIAL_PREDICTION_ENABLED` 打开后可记录 engagement prediction error、沉默结算和 repair evaluation。Self/Person/Group/World 已有 0109 evidence gate 和 counterevidence audit；group norm 模型推断默认只读，host evidence 才能写 active state；semantic debt scorer 默认关闭、只做有界排序，不自动偿还或更新长期策略。
8. **Replay 已可用但默认只读**：`replayCognitiveCorrelation` 只读取事件；只有显式 `applyProjections=true` 才会运行幂等 projection，不等价于完整 AGI 评测。
9. **paired evaluator 与真实执行窗口必须分开看**：paired evaluator 只做离线对照；真实 runner 已完成 frozen baseline 5 例和 expanded 11 例、caller/external acceptance、crash/restart、interrupt/goal-change 及 continuous-ops 汇总，但当前仅 16 例且没有 1 天/7 天 retention，报告只能称为工程证据，不能把 delta 当作学习/通用能力证据。
10. **复杂度路由只做受限行为切片**：`cognitive-routing` 已能给出可解释的 fast/deep/background 触发原因，post-judge 默认只记 counter/log；显式打开 `COGNITIVE_ROUTING_BEHAVIOR_ENABLED` 并命中 `COGNITIVE_ROUTING_CHAT_IDS` 后，非 fast Reply 才会复用 scoped workspace，deep 回合可额外启用有界的记忆/人设/导演/上下文 digest 与 critic grounding，统一唤醒循环的有信号 background tick 也可按同一门读取工作区。实际进入 Reply generation 的样本还会进入 0106 route observation，由 delivery/outcome 回填终态和反馈，供成本/质量窗口查询；researcher、CodeAct、Agency 和发送副作用不因路由自动开启，后台 route 仍需真实数据验收。
11. **task recovery summary 是观测切片，不是自动恢复器**：`getTaskRecoverySummary`/`GET /monitor/api/task-recovery` 能从 durable runtime events 和 host acceptance evidence 重建生命周期、checkpoint、计数和 verified boundary；它不会读取 Redis 任务正文，也不会替 executor 续跑、重试或把 `done` 认作成功。真实 runner 已完成 2 个 crash/restart 注入样本和 1 个 interrupt/goal-change 样本，结果已进入 long-horizon reports；仍需更大样本和 1/7 天 retention。
12. **skill verification window 不是行为验收**：`listSkillRevisionVerificationSummaries`/`GET /monitor/api/skill-verifications` 只做 bounded 静态验证 lineage 的运维投影；malformed `test_summary` 会标成 `unknown`，不会自动放行、回滚或提升 verified。真正的 held-out 负例、回放回归和跨任务迁移证据仍需独立执行。
