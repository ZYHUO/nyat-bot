# Flag census — 全量旗标清单

生成方式：`python3 scripts/flag-census.py`（纯静态：逐段读 `src/env-sections/*.ts` 的注释与默认值 + .env 实际值 + 五种读法 grep `src/`）。不打数据库、不改任何东西。

2026-09-21 起 schema 按子系统拆成 `src/env-sections/*.ts`（`src/env.ts` 只用 spread 组合），所以这份清单**按段分组**、每行带「段」列——加旗标时先在这里找该进哪一段。另带「已退役」一节：删掉的旗标留名，免得下一个人再加回来。

⚠️ 判定读者时**排除 `src/env.ts` 与 `src/env-sections/*`**——那两处只是"这个键存在"，不是"有人读它"。拆段当晚漏了这条，21 个死键一夜之间全变成"有读者"。

## 段索引

拆段的主要收益就是这个：加旗标时知道该进哪个文件。

| 段 | 文件 | 键数 | 布尔 | 生产开着 | 管什么 |
|---|---|---|---|---|---|
| `infra` | [`src/env-sections/infra.ts`](../src/env-sections/infra.ts) | 79 | 21 | 14 | Telegram / Redis / SQLite / Qdrant / NyatDB / Server / 工具与密钥 / 跟踪 / 主人与身份 / 知识库 / 媒体开关 |
| `memory` | [`src/env-sections/memory.ts`](../src/env-sections/memory.ts) | 31 | 16 | 13 | 主动参与、DM↔群记忆连结、长期记忆嵌入与相关性、CodeAct 长期记忆注入 |
| `timing` | [`src/env-sections/timing.ts`](../src/env-sections/timing.ts) | 37 | 23 | 23 | Timing Gate（去抖 + 状态机 + LLM gate + talk-value + continuation） |
| `judge` | [`src/env-sections/judge.ts`](../src/env-sections/judge.ts) | 24 | 3 | 3 | 定型判断基座 + 深度反思 |
| `cognition` | [`src/env-sections/cognition.ts`](../src/env-sections/cognition.ts) | 32 | 19 | 19 | AGI Level 4/5/6：经验沉淀、自我技能、爱好、经验验证、Dreaming、长期任务、证据门、Loop 策略、多智能体共享、世界状态、context rot、群体风格、ToM、记忆陈旧、Task 架构、反向阀门 |
| `core` | [`src/env-sections/core.ts`](../src/env-sections/core.ts) | 38 | 24 | 18 | Core v2 Phase 0（Belief View + 黑板 ACL + L2 permission gate）+ 小模型增强 |
| `self` | [`src/env-sections/self.ts`](../src/env-sections/self.ts) | 25 | 10 | 7 | 好奇心目标、自我模型、统一唤醒循环、StepFun 配额消费引擎、Mundo 难题攻坚 |
| `turn` | [`src/env-sections/turn.ts`](../src/env-sections/turn.ts) | 33 | 20 | 20 | Turn Actor + Agentic planner + 中期记忆 |
| `meta` | [`src/env-sections/meta.ts`](../src/env-sections/meta.ts) | 45 | 18 | 17 | Meta + Subagent 编排层 |
| `features` | [`src/env-sections/features.ts`](../src/env-sections/features.ts) | 51 | 21 | 18 | StepFun 全网搜索、反广告行为气压、Silence Alert、Computer-use sandbox、Learner |
| `social` | [`src/env-sections/social.ts`](../src/env-sections/social.ts) | 57 | 27 | 22 | 主动搭话、RSS 监控、天气感知、其他 bot 命令学习、Multi-Agent 协调 |
| `life` | [`src/env-sections/life.ts`](../src/env-sections/life.ts) | 36 | 14 | 13 | 硬作息门、DM 好感私聊、上学日程、心情漂移、自我叙事、NyatOS 影子、发言额度、关系叙事、TTS |

## 总量

| | |
|---|---|
| total_keys | 488 |
| bool_flags | 216 |
| on_in_prod | 187 |
| set_in_env | 323 |
| dead_no_reader | 2 |
| dead_and_on | 0 |
| phantom_only_in_tests | 0 |

**216 个布尔旗标里，生产实际开着 187 个。** 这张表的意义就在于那一段：开着的东西才是要审计的对象。

`readers` 列 = src/ 里 `env().<FLAG>` 出现的文件。`解构` 列 = 只在那里以 `const { FLAG } = env()` 之类形式出现的位置。**空 = 没人读**（要么是给脚本/外部进程读的 `process.env` 旗标，要么是死旗标）。

## 🔴 死旗标：.env 开着，但代码里一个字都没有（0 个）

这些是"以为在跑"的开关。判定要求 src/ + scripts/ + packages/ 全无命中（`env().FLAG` / 解构 / `process.env.FLAG` 三种读法都算过）。

| flag | 段 | .env | 注释怎么说 | tests/ 里有吗 |
|---|---|---|---|---|

## 🟡 假开关：只被测试 mock，src/ 不读（0 个）

比死旗标更坏——测试把它们当闸门 mock，于是"关着它"的断言其实什么都没验证。

⚠️ 2026-09-21 更正：我曾据这份清单写过"CORE_BELIEF_VIEW_ENABLED / CORE_BLACKBOARD_ENABLED / CORE_PERMISSION_GATE_ENABLED 三个全是假开关，src/core/ 那一套无条件跑着"。**前两个说法错了**——BELIEF_VIEW 在 src/core/state.ts:49 被读（`e.CORE_BELIEF_VIEW_ENABLED`），PERMISSION_GATE 在 src/core/loop.ts:292 被读（`envShim().CORE_PERMISSION_GATE_ENABLED`）。只有 BLACKBOARD 是真的没人读。教训：读法不止 `env().FLAG` 一种，而"某一列是空"不等于"没人读"。

| flag | 段 | .env | 测试里怎么用 |
|---|---|---|---|

## 生产开着的旗标（187 个）

按段分组、段内按名字排序——要加旗标时照这个找位置。

| 段 | flag | 默认 | .env | 是什么（注释摘要） | 读者 |
|---|---|---|---|---|---|
| cognition | `CONNECTIVITY_TRACKING_ENABLED` | false | 1 | ── AGI Level 6 Phase 14: 反向阀门 L7 ─────────────────────────────── 连接率埋点(新核心指标)+ 私聊风险分档。初期只记录不改行为。 | agent/reverse-valve.ts, cron/scheduler.ts |
| cognition | `DREAM_CONSOLIDATE_ENABLED` | false | true | ── AGI Level 5 Phase 2: Dreaming 整合 ─────────────────────────────── 每周一次语义合并冗余/冲突经验(MindMemOS dreaming)。走 judge 链。 | cron/dream-consolidate.ts, cron/scheduler.ts |
| cognition | `EXPERIENCE_SHARE_ENABLED` | false | true | ── AGI Level 5 Phase 5: 多智能体安全共享 ───────────────────────────── 只有 verified=1(已证实)的经验可跨 bot 共享;未验证/可疑仅本 bot 用。 | subagent/executor.ts |
| cognition | `EXPERIENCE_VERIFY_ENABLED` | false | true | ── AGI Level 5 Phase 1: 经验验证器（常驻）──────────────────────────── 注入的经验在任务终态打分：done+干净路径 → success_count；failed → failure_count。成功≥2 次 → verified=1(已证实)，失 | subagent/executor.ts |
| cognition | `GOAL_EVIDENCE_GATE_ENABLED` | false | 1 | ── Phase 2: 证据门学习 ────────────────────────────────────────── 默认 OFF:OFF 时行为与 Phase-2 之前一致(legacy 直写路径)。 开启后:goal achieved 必须 host verified;skill verif | subagent/executor.ts |
| cognition | `GOAL_LONG_TERM_ENABLED` | false | true | ── AGI Level 5 Phase 3: 长期任务语义 ──────────────────────────────── goal 升级为跨周持续关注:check_goal 主动探查世界悄悄的变化(VibeLifeBench)。 long_term goal 的 stale 窗口放宽到 30  | agent/goals.ts |
| cognition | `GROUP_NORMS_ENABLED` | false | true | ── AGI Level 5 Phase 9: 群体风格画像 ──────────────────────────────── LoSoNA: 每个群有自己的隐性规范,观察消息 → 推断 → 注入 reply。 | cron/unified-tick.ts, pipeline/reply/prompt-builder.ts |
| cognition | `HOBBY_DISTILL_ENABLED` | false | true | ── 爱好系统（从群友爱好蒸馏 bot 自己的爱好）──────────────────────── 聚合群友常聊话题 → LLM 蒸馏成 bot 自己的爱好 → 注入 self-state。 慢变量(几天重蒸馏一次),区别于 obsessions 的 3h 短周期轮换。 | cron/scheduler.ts |
| cognition | `LOOP_POLICY_ENABLED` | false | true | ── AGI Level 5 Phase 4: Loop 策略资产化 ───────────────────────────── executor 循环策略(验证/重试/停止)从静态升级为可进化资产: 注入 prompt + 任务终态计数,成功率 <30% 自动 disable。 | subagent/executor.ts |
| cognition | `MEMORY_FRESHNESS_ENABLED` | false | true | ── AGI Level 5 Phase 12: 记忆陈旧检测 ─────────────────────────────── 超期未确认 → stale 降权;变化词(换工作/分手) → 相关旧属性 stale。 只检测不自动删;检索到 stale 时注明可能过时。 | pipeline/reply/reply.ts, pipeline/stages/bookkeeping.ts |
| cognition | `RECALL_BUDGET_ENABLED` | false | true | ── AGI Level 5 Phase 8: Context rot 防护 ───────────────────────────── 少召回+重排+最高信号放前(防「迷失在中间」/干扰项误导)。 | subagent/executor.ts |
| cognition | `REVERSE_VALVE_ENABLED` | false | 1 | Phase 14.1 接线: DM 风险 → 写手提示 + humanizer 衰减。默认 OFF,OFF 时 currentRiskLevel 恒 low(提示/衰减全是 undefined,行为与改造前逐字节一致)。 只在 DM(chatId > 0)生效,群聊零变化。 | agent/reverse-valve.ts, pipeline/reply/prompt-builder.ts, pipeline/stages/bookkeeping.ts, pipeline/stages/deliver.ts |
| cognition | `SELF_EDIT_GUARDRAILS_ENABLED` | false | 1 |  | agent/self-improve.ts, subagent/host-api.ts |
| cognition | `SKILL_CONSOLIDATE_ENABLED` | false | true |  | cron/scheduler.ts |
| cognition | `SKILL_DISTILL_ENABLED` | false | true | ── 自我技能沉淀（AGI 自我 skill 系统）──────────────────────────────── 每 6h 从 episodes + experience_entries 蒸馏「小 skill」,每周合并去重 成「大 skill」并归档小 skill 防爆。skill 是结构化能 | cron/scheduler.ts |
| cognition | `SKILL_VERIFIED_USE_ENABLED` | false | 1 |  | subagent/executor.ts |
| cognition | `TASK_EXECUTOR_ENABLED` | false | true | ── AGI Level 6 Phase 13: Task 对象架构 ───────────────────────────── 补 harness 的「执行+状态」:BullMQ 独立队列跑任务,与消息处理隔离。 | agent/task-store.ts, cron/scheduler.ts, pipeline/judge/task-trigger.ts, pipeline/pipeline.ts |
| cognition | `TOM_STATE_ENABLED` | false | true | ── AGI Level 5 Phase 10: ToM 心智状态层 ───────────────────────────── 回复前先想「对方想要什么/什么情绪/期待什么反应」,白捡的策略性收益。 | pipeline/reply/reply.ts |
| cognition | `WORLD_STATE_ENABLED` | false | true | ── AGI Level 5 Phase 6: 轻量世界状态 ──────────────────────────────── 对象中心实体(person/project/topic)持续维护,goal check 开工前注入上下文。 | subagent/executor.ts |
| core | `AGENCY_FAIL_CLOSED` | true | None |  | **无人读** |
| core | `COGNITIVE_CONTINUITY_ENABLED` | false | true | Event-backed mission/process continuity. It only emits durable wake and checkpoint records; tools and Telegram side effects still need a separate host | cron/scheduler.ts |
| core | `COGNITIVE_EVENTS_ENABLED` | true | true | Durable perception/event log. Disable only for emergency rollback; callers remain fail-soft when the migration is not present yet. | agent/cognitive-events.ts |
| core | `COGNITIVE_KERNEL_ENABLED` | false | true | Event-sourced NyatOS kernel shadow. It records one trigger/frame/action chain but does not replace the legacy sender until a canary opts in. | agent/cognitive-kernel.ts, pipeline/pipeline.ts |
| core | `COGNITIVE_KERNEL_RECOVERY_ENABLED` | false | true | Close kernel actions whose dispatch budget expired after a crash. It only writes terminal `interrupted` outcomes; it never re-sends a message. | agent/cognitive-recovery.ts, cron/scheduler.ts |
| core | `COGNITIVE_OUTBOX_ENABLED` | true | true |  | agent/cognitive-events.ts, cron/scheduler.ts |
| core | `COGNITIVE_PROCESS_RUNTIME_ENABLED` | false | true | Host-side process wake execution. It only projects recent metadata and checkpoints durable wakes; it does not grant authority or call an LLM. | cron/scheduler.ts |
| core | `COGNITIVE_ROUTING_BEHAVIOR_ENABLED` | false | true | Optional behavior rollout: deep Reply routes and signal-bearing background ticks may opt into the scoped workspace. Empty chat list means all chats; k | cron/unified-tick.ts, pipeline/stages/post-judge.ts |
| core | `COGNITIVE_ROUTING_ENABLED` | false | true | Deterministic fast/deep/background routing telemetry. It is shadow-only until a later rollout explicitly consumes the decision for behavior. | cron/unified-tick.ts, pipeline/stages/post-judge.ts |
| core | `COGNITIVE_WORKSPACE_V2_ENABLED` | false | true | Assemble the scoped cognitive workspace for legacy reply/Heart/Meta paths. Keep it opt-in until latency and prompt-budget measurements are available. | cron/unified-tick.ts, meta/heart-adapter.ts, meta/session.ts, pipeline/heart/heart.ts |
| core | `CORE_BELIEF_VIEW_ENABLED` | false | true | ── Core v2 Phase 0: Belief View + 黑板 ACL + L2 permission gate ── 全部默认 OFF。Phase 0 是纯地基（新表+纯函数），不接任何主路径， 开了也只影响 eval harness 和未来的 graylist 群。 | core/state.ts |
| core | `CORE_BLACKBOARD_ENABLED` | false | true |  | core/blackboard/store.ts |
| core | `CORE_DUAL_WRITE` | true | None | Phase 2 双写：旧表写入后同步 belief（读投影）。默认开（best-effort， 失败只打日志不拦路）。关掉则 core_beliefs 停更，读侧照常。 | core/migrate.ts |
| core | `CORE_V2_ENABLED` | true | None | 总开关（默认开；关掉则 isCoreChat 全 false，shadow 零开销）。 | core/loop.ts |
| core | `SOCIAL_ACT_SHADOW_ENABLED` | false | true | Phase 1 SocialAct shadow: records the legacy judge's action contract only. It never sends, changes reply selection, or stores message text. Empty chat | pipeline/pipeline.ts, pipeline/stages/deliver.ts |
| core | `SOCIAL_PREDICTION_ENABLED` | false | true | Metadata-only group interaction expectations and host-observed social prediction error. It never changes reply selection; keep rollout opt-in. | cron/scheduler.ts, pipeline/stages/deliver.ts, subagent/host-api.ts |
| core | `SYCOPHANCY_AUDIT_ENABLED` | false | true | 谄媚审计: 每周抽 200 条回复按五维打分,纯离线。 | cron/scheduler.ts, cron/self-reflect.ts, cron/sycophancy-audit.ts |
| core | `WORLD_FACTS_ENABLED` | false | true | Record what Telegram reports about a chat (title/type/username/description) as host-observable world facts. This is the missing producer for `world_ch | meta/bookkeeping.ts |
| features | `CODEACT_LINUXSB_ENABLED` | false | true |  | subagent/host-api.ts |
| features | `CODEACT_PIXIV_ENABLED` | false | true | Subagent host pixiv/linux.sb 只读工具。默认关，按灰度开。 | subagent/host-api.ts |
| features | `CODEACT_WEB_SEARCH_ENABLED` | true | None |  | subagent/host-api.ts |
| features | `CONTEXT_ENGINE_ENABLED` | true | true | Context Engine:组装 Meta/Subagent prompt 时打 Manifest(可观测+稳定前缀)。 | context-engine/index.ts |
| features | `CONTROL_BASELINE_ENABLED` | true | None | 踢人（admin.kick）总闸。默认关。 为什么单独一个 flag 而不跟 ANTIAD_ENABLED 绑：删消息/禁言可逆，踢人不可逆 （对方要自己加回来）。群主明确要"能踢"才开，且仍由模型按 Frame 里的事实决定。 同时段对照基线采集 cron。默认开；它纯只读（只拍快照），关掉只会让 | cron/scheduler.ts |
| features | `DREAM_JOURNAL_ENABLED` | false | true | 日记 dream-journal(独立 flag,可不启 Meta 单独开)。 | cron/dream-journal.ts, cron/scheduler.ts, cron/sleep-cycle.ts, meta/session.ts |
| features | `DREAM_JOURNAL_HOOK_SLEEP` | true | true | 是否在硬作息起床/入睡边沿各试写一次(模型仍可 SKIP)。 | cron/sleep-cycle.ts |
| features | `EXPRESSION_INJECT_ENABLED` | false | true |  | pipeline/reply/prompt-builder.ts |
| features | `JARGON_QUERY_ENABLED` | false | true |  | pipeline/tools/jargon-tool.ts |
| features | `LEARNER_ENABLED` | false | true | ── Learner (Expression + Jargon, Stage D) ── | cron/learner-scan.ts, cron/scheduler.ts |
| features | `SANDBOX_BROWSER_ENABLED` | true | None |  | sandbox/browser.ts |
| features | `SANDBOX_BWRAP_ENABLED` | true | None | Phase 15 真隔离: bwrap userns 沙盒默认开。 | sandbox/terminal.ts |
| features | `SANDBOX_ENABLED` | false | true | ── Computer-use sandbox (Playwright + terminal) ── ⚠️ 安全边界说明(2026-08-22 审查): computer.run 走宿主 /bin/sh -c 执行, 危险命令 模式集(sandbox/terminal.ts)只是纵深防御——**不是 | sandbox/paths.ts, subagent/host-api.ts |
| features | `SANDBOX_REQUIRE_ISOLATION` | true | None | 隔离能力不可用时默认拒绝执行；仅在明确应急配置为 false 时允许宿主回退。 | sandbox/terminal.ts |
| features | `SANDBOX_TERMINAL_ENABLED` | true | None |  | sandbox/terminal.ts |
| features | `SILENCE_ALERT_ENABLED` | false | true | ── Silence Alert —— bot 沉默检测(端到端回复健康)── 监控「最近有人类活跃但 bot 超阈值没回复」的 chat,告警到 owner DM。 默认关;开时需配 SILENCE_ALERT_CHAT_ID(owner DM chatId)才真正发送,否则只打日志。 | cron/scheduler.ts, cron/silence-alert.ts |
| features | `STEPFUN_SEARCH_ENABLED` | true | true | ── StepFun 全网搜索（2026-09-20 起作为**主路由**）──────────────── 原 4 条 fallback 链（Gemini grounding / new-api grok / SearxNG / DDG）整体保留为 后备，但默认走 stepfun 的 POST / | pipeline/tools/search.ts |
| features | `TIC_PENALTY_ENABLED` | false | true | 口头禅自动惩罚闭环:盯 bot 自己发言,句首/句尾短语复读超阈值 → 自动降权 + 带 TTL 动态拉黑(注入不喂回 + prompt 提示"少说")+ 到期自愈。默认关。 | cron/scheduler.ts, cron/tic-penalty.ts, pipeline/reply/reply.ts |
| infra | `ALLOWLIST_AUTO_AI_REVIEW` | true | true |  | allowlist/bot-flow.ts, cron/sleep-cycle.ts |
| infra | `ALLOWLIST_BOT_FLOW_ENABLED` | false | true | Bot 对话流申请（2026-08-20 起替代 miniapp 提交）：申请人私聊 bot 报群 ID/@username， bot 调 allowlist.apply 自动审核——申请人须为目标群 creator/administrator 才允许 AI 通过即启用（身份经 getChatMem | subagent/host-api.ts |
| infra | `ALLOWLIST_ENABLED` | false | true | Allowlist | allowlist/bot-flow.ts, cron/sleep-cycle.ts |
| infra | `ALLOWLIST_REVIEW_ON_JOIN` | false | true | bot 被拉进群 → 立即自动跑一遍 AI 审核（不等申请）。拉群人是群管理才可自动启用。 | bot/handlers/member.ts |
| infra | `CRON_ENABLED` | true | None | Cron master switch — read via env() like every other flag (kilo review). | cron/scheduler.ts |
| infra | `JUDGE_KNOWLEDGE_GROUP` | true | None |  | core/state.ts, pipeline/judge/judge.ts |
| infra | `JUDGE_KNOWLEDGE_PERMANENT` | true | None |  | core/state.ts, pipeline/judge/judge.ts |
| infra | `NYATDB_DUAL_WRITE` | false | true |  | pipeline/context/manager.ts, pipeline/context/mid-term.ts |
| infra | `NYATDB_ENABLED` | false | true | NyatDB — NyatBot-only embedded engine (MemTable+WAL+zstd). Default off. | nyatdb/index.ts, pipeline/context/manager.ts, pipeline/context/mid-term.ts |
| infra | `NYATDB_NATIVE` | false | true |  | nyatdb/index.ts |
| infra | `NYATDB_READ` | false | true |  | pipeline/context/manager.ts |
| infra | `OUTCOME_TRACKING_ENABLED` | false | true | Tracking | meta/bookkeeping.ts, pipeline/heart/decision.ts, pipeline/stages/bookkeeping.ts, pipeline/stages/deliver.ts |
| infra | `VERIFY_ENABLED` | false | true | Join verification | cron/scheduler.ts |
| infra | `VIDEO_DESCRIBE_ENABLED` | true | true | 视频理解（2026-09-21）。默认开——它跟 audio/PDF 那俩不一样:那两个是"供应商 读不了所以必败"，这个是**真的能跑**。实测 step-5-preview 吃 base64 video_url， 6 秒测试视频准确描述了内容。关掉只退回中性占位（[视频]），不会报错。  为什么 | pipeline/multimodal.ts |
| judge | `JUDGE_SUBSTRATE_ENABLED` | false | true | ── 定型判断基座 src/ai/judge-substrate.ts ─────────────────────── bot 每天 ~45M token 大多花在"换回一个小决定"（gate 三选一、heart 说/等/不说、 shadow、judge）。这里把这类判断收敛到一个可插拔基座：typ | ai/judge-substrate.ts |
| judge | `REFLECTION_ENABLED` | false | true | ── 深度反思(A:把 StepFun 配额花在"让 bot 记住群里发生过什么")── 后台 cron 对活跃群喂大窗口历史 → 产出每群"近况摘要"注入回复。吞吐可调: token/天 ≈ CHATS_PER_TICK × (WINDOW×~15) × (1440/INTERVAL_MIN)。默 | cron/deep-reflection.ts, cron/scheduler.ts, pipeline/reply/reply.ts |
| judge | `TURN_GATE_CONTINUATION` | false | true | P0-A 连续对话免检:gate continue / bot 回复后 N 秒内的后续消息跳过 gate LLM (对齐 MaiBot 连续 Planner 状态)。更新的 wait/no_action 负向决策自动终止免检。 | pipeline/heart/heart.ts, pipeline/timing/chat-runtime.ts, pipeline/timing/gate.ts |
| life | `COGNITIVE_CLOCK_ENABLED` | false | true | 认知时钟：把模型自己的行动结果写进事件账本（own_action_result）， 并允许它记录"下次什么时候再想"（self_scheduled_wake）。 没有前者，模型看不见自己刚做过什么（自激事故的根因）；没有后者， 注意力主权在宿主手里，系统永远是被动应答器。 | tracking/self-history.ts |
| life | `CONTROL_DIRECTIVE_ENABLED` | false | true | 控制指令(别理我/别理某人/可以说话了/记住X/忘掉X):typing 前用 LLM 听懂 → 静默执行 + emoji ack,取代旧的 L0 关键词 regex。默认关。 | pipeline/stages/deliver.ts |
| life | `MOOD_ENABLED` | false | true | ── Mood drift (Stage E) ── Bot 每个群独立 valence ∈ [-100, 100]，随事件起伏，按时间向 0 衰减。 | tracking/mood.ts |
| life | `MOOD_INJECT_ENABLED` | false | true | 是否把 mood hint 注入 reply prompt | tracking/mood.ts |
| life | `NYATOS_BUDGET_ENABLED` | false | true | ── NyatOS 发言额度：宿主提供的物理节流，但模型可见 ── 2026-09-18 的 54 样本实测：单决策点在 28 分钟内想说 48 次（中位间隔 7 秒）， 即使明确告知"你刚发了 4 条没人回"仍然继续想说。所以旧 cooldown 的第二份 工作——防止自我重复失控——不能交给模型 | nyatos/budget.ts, pipeline/stages/deliver.ts, subagent/host-api.ts |
| life | `NYATOS_SHADOW_ENABLED` | false | true | ── NyatOS Phase 2: 单决策点并联影子 ── 用同一个 Frame 跑一次「说话/等待/不说」的判断，**只记录不发送**， 与现有 pipeline 的实际选择对比。目的是在信任新架构之前先量化它， 而不是直接上线然后观察。绝不产生任何外部副作用。 | bot/handlers/message.ts, subagent/post-task-window.ts |
| life | `RELATIONSHIP_ENABLED` | false | true | ── Relationship narrative (Stage F): 每对 (chat,user) 累计 affinity ── | agent/hypothesis-updates.ts, pipeline/reply/prompt-builder.ts, tracking/relationship.ts, tracking/user-affinity.ts |
| life | `SCHOOL_SCHEDULE_ENABLED` | false | true | ── Daily life / school schedule ── 16 岁人设的「每日安排」：school=周课表，summer=暑假日计划，auto=7–8 月暑假否则上学。 SCHOOL_SCHEDULE_ENABLED 关 → 不注入。睡眠硬门仍优先于本模块。 | cron/scheduler.ts, cron/school-day-plan.ts, pipeline/heart/self-state.ts, tracking/school-state.ts |
| life | `SELF_HISTORY_ENABLED` | false | true | ── Self-narrative (Stage F): bot 记得自己对每个用户说过什么 ── 同一开关也驱动"我最近在这个群的整体表现"（含每条消息的真实结果）， 心流决策会看到这个事实块 —— 模型据此自己判断要不要收着点。 | meta/heart-adapter.ts, pipeline/heart/heart.ts, pipeline/reply/prompt-builder.ts, tracking/self-history.ts |
| life | `SLEEP_ANNOUNCE_ENABLED` | false | true | 到点睡觉/起床时向最近活跃的群发晚安/早安(固定短句池,无 LLM) | cron/sleep-cycle.ts |
| life | `SLEEP_BEDTIME_GUARD_ENABLED` | false | true | 晚安时机守卫:就寝边沿若 bot 5 分钟内在活跃群说过话(对话中),推迟 入睡相位 10 分钟,每晚最多 3 次 —— 治"自己刚回完话 50 秒就道晚安蒸发"。 | cron/sleep-cycle.ts |
| life | `SLEEP_DM_ENABLED` | false | true | ── DM 好感主动私聊 (功能 B) ── B1:睡前/起床给「已私聊过 bot 的高好感用户」发悄悄话(带跨群外号)。默认关。 | cron/sleep-cycle.ts, pipeline/dm-proactive.ts |
| life | `SLEEP_SCHEDULE_ENABLED` | false | true | ── Sleep schedule(硬作息门):到点真睡觉,睡觉不闲聊,指令照常 ── 直接交互(@/回 bot/私聊)走升级式吵醒,主人必醒;作息表沿用 life-state 的 date-seeded daySchedule(起床 07:00-08:30 / 入睡 23:30-01:00) | cron/scheduler.ts, cron/sleep-cycle.ts, tracking/sleep.ts |
| memory | `CACHE_WARMUP_ENABLED` | false | true | 优化:缓存预热——定时拿静态 system 前缀 ping 回复模型,保持 DeepSeek 前缀缓存热(默认关)。 | cron/cache-warmup.ts, cron/scheduler.ts |
| memory | `DM_AUTO_PRIVATE` | true | true | DM 是否自动判为私密会话(CGM dmAutoPrivate)。默认 true。 | memory/visibility.ts |
| memory | `FLOOR_ENABLED` | false | 1 | H1.1 floor/addressee 三档（默认 OFF，OFF = 老路零变化）。 开后：ambient/not_me 先记 floor_decisions 再按规则短路，to_me 才进 judge。 | pipeline/pipeline.ts, pipeline/stages/deliver.ts, pipeline/stages/post-judge.ts |
| memory | `JUDGE_PROACTIVE_ENABLED` | false | true | ── Proactive Engagement (Stage B) ── | pipeline/judge/judge.ts |
| memory | `MEMORY_CROSS_CONTEXT_ENABLED` | false | true | 机制4 跨上下文记忆召回:per-uid 旁路检索(不锁 chatId),返回强制过 visibility scrub(默认带 public + 非私密来源 contextual,private 一律剔除)。 **必须** MEMORY_VISIBILITY_ENABLED 也开才生效(fail-c | memory/chroma.ts, pipeline/context/retriever.ts, subagent/host-api.ts |
| memory | `MEMORY_VISIBILITY_ENABLED` | false | true | ── DM↔群记忆连结(借鉴 CyberGroupmate 以人为中心统一记忆;docs/dm-group-memory-*.md)── 机制1 隐私 visibility 兜底:记忆/画像跨上下文返回前按 private/contextual/public 逐条 scrub(DM 默认 priva | memory/chroma.ts, memory/visibility.ts, pipeline/context/retriever.ts, subagent/host-api.ts |
| memory | `METRICS_ENABLED` | false | true | （原 PROACTIVE_SCAN_* / PROACTIVE_PRESSURE_* / SCHEDULE_LLM_WAKE 三个旗标 2026-09-21 删除：全仓库无一处读取，.env 里却开着。前者对应的独立 scan cron 已被 unified-tick 取代，后两者描述的机制从未落地 | **无人读** |
| memory | `PERSON_IDENTITY_ENABLED` | false | true | 跨群人物身份(借鉴 CGM 两层人物模型):在别的群也认得的人,带上跨群整体印象。默认关。 | cron/profile-merge.ts, pipeline/reply/prompt-builder.ts, tracking/person-identity.ts |
| memory | `PROFILE_MERGE_ENABLED` | false | true | 机制5 LLM 全局画像合并 cron:低频把某人各上下文(群+DM)画像喂便宜模型提炼成 全局 traits/interests/relation,写回 person_identity 全局列。默认关。 | cron/profile-merge.ts, cron/scheduler.ts, tracking/person-identity.ts |
| memory | `REPLY_VISION_ENABLED` | false | true | P2 多模态直读:回复写手调用直接带原图(默认关 = 只用文本描述)。 开前确保回复链主 label 声明 AI_PROVIDER_<NAME>_VISION=true, 纯文本 label 声明 VISION=false 让 fallback 跳过(不白烧 400)。 | pipeline/reply/reply.ts |
| memory | `SLEEP_WAKE_ON_DM_ENABLED` | false | true | DM↔群联动:睡着时收到私聊 → 全局临时唤醒(群里也醒、正常处理消息),窗口内每条 DM 续期, 静默后到点自动继续睡。默认关。 | meta/bookkeeping.ts, pipeline/pipeline.ts, tracking/sleep.ts |
| memory | `SUBAGENT_MEMORY_ENABLED` | false | true | ── CodeAct 自动注入长期记忆 ────────────────────────────── 接在 subagent/executor.ts(真正生成话语的那层),**不是** Meta 编排器 —— Meta 的引擎跨所有会话,其输出经 digest/梦境日记扩散到每个群的 prompt, | subagent/memory-context.ts |
| memory | `TOPIC_REGISTRY_ENABLED` | false | true | 话题生命周期注册表(借鉴 CGM Topic Registry):cron 抽取各群当前话题 + 注入「当前话题」。默认关。 | cron/scheduler.ts, cron/topic-scan.ts, pipeline/reply/prompt-builder.ts |
| meta | `AGENT_LOOP_ENABLED` | false | true | 长时间 Agent 循环：分段续跑 + checkpoint + 上下文压缩。默认关，灰度开。 | subagent/executor.ts |
| meta | `DEBT_AUTO_MATCH_ENABLED` | false | true | Durable cognitive event projection is safe to run without authority; debt creation remains a separate opt-in until its false-positive rate is known. | cron/scheduler.ts |
| meta | `DEBT_SWEEP_ENABLED` | false | true | （TASK_PROGRESS_CODEACT_ENABLED / TASK_PROGRESS_RESEARCH_ENABLED 2026-09-21 删除： 两个都默认 true 而全仓库无一处读取。task-progress.ts 只读 TASK_PROGRESS_ENABLED， 这两个"按任务 | cron/scheduler.ts |
| meta | `DIGEST_PERSIST_ENABLED` | false | true |  | cron/unified-tick.ts, meta/session-digest.ts, meta/session.ts, subagent/host-api.ts |
| meta | `DREAMING_ENABLED` | false | true |  | cron/dreaming.ts, cron/scheduler.ts |
| meta | `GROUNDING_ENABLED` | false | true |  | meta/grounding.ts, meta/session.ts, subagent/executor.ts |
| meta | `GROUP_NORMS_AUTO_UPDATE_ENABLED` | false | true | LLM group-norm proposals do not mutate the durable hypothesis by default; verified host evidence uses the separate evidence-gated updater. | agent/group-norms.ts |
| meta | `META_DEFER_ENABLED` | false | true |  | bot/handlers/message.ts, meta/dispatch-gate.ts, meta/loop.ts, meta/timing-adapter.ts |
| meta | `META_DISPATCH_GATE_ENABLED` | false | true |  | meta/dispatch-gate.ts |
| meta | `META_SUBAGENT_ENABLED` | false | true | ── Meta + Subagent (CyberGroupmate-shaped orchestration inside nyatbot) ── 默认关。开启后灰名单群走 Attention→Meta→dispatch→CodeAct Subagent→callback, 不再走 BullMQ  | cron/dream-journal.ts, meta/flags.ts, meta/loop.ts, meta/timing-adapter.ts |
| meta | `POST_TASK_WINDOW_ENABLED` | false | true |  | subagent/post-task-window.ts |
| meta | `PROMISE_LOOP_ENABLED` | false | true |  | subagent/host-api.ts |
| meta | `RELATIONSHIP_PROFILE_TRIM_ENABLED` | false | true |  | tracking/relationship-quant.ts |
| meta | `RELATIONSHIP_QUANT_ENABLED` | false | true |  | cron/dreaming.ts, cron/relationship-summarize.ts, tracking/relationship-quant.ts |
| meta | `REPLY_HUMANIZER_SAFE_MODE` | true | None |  | pipeline/stages/deliver.ts |
| meta | `REPLY_LONG_TEXT_SAFE_SPLIT_ENABLED` | true | None | 回复形态与安全分段：先灰度控制，关闭时保留旧回复路径。 （REPLY_MODE_ENABLED / REPLY_ACK_THEN_EXPAND_ENABLED / REPLY_MICRO_REACTION_MAX_CHARS / REPLY_ACK_MAX_CHARS / REPLY_MAX_EXP | pipeline/reply/reply.ts |
| meta | `TASK_PROGRESS_ENABLED` | true | None | 长任务用户可见阶段通知：运行时负责短确认/保活，失败不影响任务执行。 | agent/task-progress.ts |
| self | `MOOD_TUNE_ENABLED` | false | true | 心情/精力 → humanizer 参数调制 (Opus 评审: 随机性不该是 IID; 累/被怼时回复更短更敷衍, 心情好时更活泼)。合并序: 群风格 < mood-tune < 运营 override < ASI self-tune。 | pipeline/stages/deliver.ts |
| self | `OWN_HISTORY_RETRIEVAL_ENABLED` | false | true | 机制5: bot 自己的历史发言语义检索(Opus 评审: 翻旧账/自洽能力)。 检索本群与当前话题相关的自发言, 作为独立参考块注入(不进 merged)。 | pipeline/context/retriever.ts |
| self | `RELATIONSHIP_ASYMMETRY_ENABLED` | false | true | 好感非对称动力学 (Opus 评审: 信任慢升快降 —— 伤害一次掉很多, 修复要几十次正交互)。开启后正 delta × UP(慢), 负 delta × DOWN(快)。 | tracking/relationship.ts |
| self | `TIMING_GATE_FAIL_CLOSED` | false | true | P2-E 解析失败方向:true = fail-closed 按 no_action 处理(MaiBot 语义:宁可 沉默不插嘴;direct 已在上游 bypass;强债务转保护性 wait)。llm_call_failed (网络)仍 fail-open。与仓库约定一致:行为变化默认关,.env | pipeline/timing/gate.ts |
| self | `TIMING_GATE_HISTORY_ENABLED` | false | true | P1-D gate 有状态化:把最近 5 次真实 LLM 决策注入 gate prompt(对齐 MaiBot gate 与 planner 共享历史、看得到自己过往节奏判断)。 | pipeline/timing/gate.ts |
| self | `TIMING_WAIT_HINT_ENABLED` | false | true | P2-F wait 到点回访时注入 [等待结束] 提示(仅 TURN_WAIT_RESUME_ENABLED 路径)。 | pipeline/stages/deliver.ts |
| self | `UNIFIED_TICK_ABSENT_USERS_ENABLED` | false | true | unified-tick 熟面孔缺席检测(Opus 评审: 主动消息要有理由—— "想起某人三天没出现")。开启后世界状态会带 absentUsers, 决策模型可选 remember_user 动作。 | cron/unified-tick.ts |
| social | `BOT_CLASSIFIER_ENABLED` | false | true | 入站 bot 消息分类层(A 多bot共存 / D 降噪 / 命令学习 的共用地基)。 先 shadow:打标 + 日志,不改任何行为;精度够了再让 A/D 消费。 | pipeline/pipeline.ts |
| social | `BOT_COMMAND_LEARN_ENABLED` | false | true | ── 借力其他 bot(学其他 bot 的命令,需要时代发)── P1:观察学习每个 bot 的命令档案(怎么用/场景/needs_reply/needs_admin/output_type) | cron/bot-command-scan.ts, cron/scheduler.ts |
| social | `BOT_COMMAND_ROUTER_ENABLED` | false | true | 「调用路由」:@bot/回复bot 且意图明确匹配某条 ready 已学命令 → 专职廉价 LLM 判一次、 命中就代发(脱离主回复模型的选工具)。保守触发、安全闸全在 tryDelegateCommand。默认关; 依赖 BOT_DELEGATION_ENABLED。 | pipeline/command-router.ts, pipeline/stages/intercepts.ts |
| social | `BOT_DELEGATION_ENABLED` | false | true | P2:成熟后真正代发命令(USE_BOT_COMMAND 工具)。默认关 —— 没学够/没开就只"教用户" | meta/bookkeeping.ts, pipeline/command-router.ts, pipeline/stages/intercepts.ts, pipeline/tools/bot-delegation.ts |
| social | `BOT_DENOISE_ENABLED` | false | true | D 选择性降噪:对 ad/verify/echo 类其他 bot 消息,跳过 judge/digest/学习 (保留进 ctx,不删)。依赖 BOT_CLASSIFIER_ENABLED 的 botClass。默认关。 | pipeline/pipeline.ts |
| social | `BOT_REPLY_DELEGATION_ENABLED` | true | true | 回复式代发(bots.command 带 replyToMessageId):让别的 bot 代罚。 默认开——它比 admin.kick 更窄:只能发"必须回复某条消息才生效"且学熟 (needs_reply=1 / needs_admin=0 / status=ready)的命令,且与 admi | pipeline/tools/bot-delegation.ts |
| social | `MULTI_AGENT_CHAT_SPECIALISTS` | true | true | chat 路径也跑记忆员+人设员+导演(direct 闲聊也带 grounding,多走 agentic、多吃 token; 嫌延迟可关)。研究员/核查/Critic 仍只在 lookup/deep。 | pipeline/multiagent/orchestrator.ts |
| social | `MULTI_AGENT_CHECKER_ENABLED` | true | true | Phase 3 核查员:核查研究员产出(lookup + deep 路径跑,有研究员素材才跑)。 | pipeline/multiagent/orchestrator.ts |
| social | `MULTI_AGENT_CONTEXT_DIGEST_ENABLED` | true | true | 上下文理解专家:忙群(最近消息数 ≥ 阈值)先把最近 N 条 digest 成"现在在聊啥" 给写手,降写手 prompt 噪音 + 多吃一次 token。全路由并行。 | pipeline/multiagent/orchestrator.ts |
| social | `MULTI_AGENT_CRITIC_ENABLED` | true | true | Phase 4 Critic:草稿二审,不行回炉(deep 总是跑;lookup 默认关)。回炉轮数上限。 | pipeline/multiagent/orchestrator.ts |
| social | `MULTI_AGENT_DIRECTOR_ENABLED` | true | true | 导演专家(写手前):读上下文+念头,产出"情绪/姿态/切入点"块喂写手。全路由并行。 | pipeline/multiagent/orchestrator.ts |
| social | `MULTI_AGENT_MEMORY_ENABLED` | true | true | Phase 2 记忆员:agentic RECALL(语义记忆检索)专家,与研究员并行 fan-out。 | pipeline/multiagent/orchestrator.ts |
| social | `MULTI_AGENT_PERSONA_CRITIC_ENABLED` | true | true | 人设一致性 Critic:每条回复都查"有没有叫错主人/破人设/破关系",有问题回炉 1 次。 跟深度 Critic(查事实/跑题)分工:这个专攻人设/关系,全路由跑。 | pipeline/multiagent/orchestrator.ts |
| social | `MULTI_AGENT_PERSONA_ENABLED` | true | true | Phase 5 人设/关系专家:QUERY_PERSON_PROFILE + FETCH_HISTORY,搞清"在跟谁说、 该用什么语气"。chat 路径也跑(默认),lookup/deep 并行 fan-out。 | pipeline/multiagent/orchestrator.ts |
| social | `NETWORK_BURST_ENABLED` | false | true | C 网络事件 burst:群里集体喊"挂了/CF炸了/502"时冒一句。reactive,默认关。 | meta/bookkeeping.ts, pipeline/games/network-burst.ts, pipeline/stages/bookkeeping.ts |
| social | `PEER_REACTION_ENABLED` | false | true | A 多 bot 共存:对会话型 bot(千雪)/带媒体结果的工具 bot(解析姬)做反应。 reactive、不走 judge,自带 chat-lock + per-peer fatigue + 作息门。默认关。 | meta/bookkeeping.ts, pipeline/games/peer-reaction.ts, pipeline/pipeline.ts |
| social | `REALTIME_LEARN_ENABLED` | true | true | 实时学习:每条回复后异步抽"这轮聊了啥/跟此人关系有没有变化"写 episode + 关系。 替代部分批量 cron,记忆更鲜活。fire-and-forget,不阻塞回复。 | subagent/host-api.ts, tracking/realtime-learn.ts |
| social | `REPLY_DIRECT_TOOLS_ENABLED` | false | true | P3:direct(普通闲聊)路径也挂工具 —— 现状是 judge 判 direct 后写手完全无工具, 群里随口问"这链接是啥/现在油价多少"只能瞎编。开启后 direct 也走合并写手, 但只给只读子集(搜索/抓页/记忆/画像/历史/bot知识/黑话),不给 ADD_TIMER/ CREATE | pipeline/reply/reply.ts |
| social | `REPLY_MERGED_TOOLS_ENABLED` | false | true | 合并写手:planned 路径用"一次带工具的写手调用"替代"planner 轮+写手"两段 (默认关,灰度;失败自动回退老两段路径) | pipeline/reply/reply.ts |
| social | `RSS_MONITOR_ENABLED` | false | true | ── P2-B: RSS 信息流监控 ── 周期轮询 RSS feeds，新条目存 Redis 供主动搭话引用 | cron/rss-monitor.ts, cron/scheduler.ts, cron/unified-tick.ts, pipeline/turn/proactive-turn.ts |
| social | `WEATHER_ENABLED` | false | true | ── 天气环境感知（真人感）── wttr.in 免费源，30min 缓存；注入 self-state / tick WorldState，全 fail-soft。 | shared/weather.ts |
| social | `WRITER_SELECTOR_ENABLED` | true | true |  | pipeline/multiagent/orchestrator.ts |
| timing | `AGENCY_CONTROL_ADAPTERS_ENABLED` | false | true | Agency 控制动作的宿主实现（observe/remember/correct/stop）。 agency-control-adapters 只提供"外壳"（scope/预算/回执契约），宿主实现从未提供， 所以 runtime 派发这些动作时没有可执行体。实现见 agency-host-ada | agent/agency-host-adapters.ts, agent/agency-proposals.ts |
| timing | `BELIEF_VERIFY_ENABLED` | false | true | 信念验证：消费 stale_belief 债务（world_change 产生），把被世界变化证伪的 信念标为 contradicted（getActiveBeliefs 已排除，不再进 prompt）。 此前三件套都在、互不相识：world-facts 产生事件 → projector 建债务 → | agent/belief-verify.ts, cron/scheduler.ts |
| timing | `ECHO_ENABLED` | false | true |  | agent/echo.ts, cron/scheduler.ts |
| timing | `GROUNDING_CHECK_ENABLED` | false | true | （SEMANTIC_DUP_THRESHOLD 2026-09-21 删除：全仓库（src/scripts/packages/tests，含 .sh）无一处读取。semantic-dup.ts 的判定阈值是写死的 0.7，没读这个键） 接地性守卫：bot 断言一个聊天里没人提过、用户也没问的具体数字 | subagent/host-api.ts |
| timing | `HEART_COOLDOWN_AS_FACT` | false | true | 冷却作为"事实"交给模型，而不是静默丢弃。 旧行为把决定权从模型拿走，且 dispatch gate 还会再拦一次—— 而 heart 的 LLM 调用已经烧掉了（实测 6h 内 68 次 cooldown 短路发生在 heart 决定 reply 之后）。开=模型自己掂量；关=旧的静默丢弃。 | meta/heart-adapter.ts, pipeline/heart/heart.ts |
| timing | `HEART_DECIDES_TIMING` | false | true | heart 已经带事实做过时机判断（它自己就是 gate）→ 派发前不再重复过闸。 实测 6h 内 68 次 cooldown + 38 次 talk-value 短路发生在 heart 决定 reply 之后 = 那次 heart 调用白烧。开=模型自己控制；关=旧的双闸行为。 | meta/session.ts |
| timing | `HEART_LLM_FAIL_KEEP_ADDRESSED` | true | true | 心流 LLM 失败时的**保句闸**（2026-09-21 新增的前置功能）。  实测：`heart LLM failed, fail-closed pass` 在日志里 1867 次，占全部心流 裁决（7443 次）的 25%；失败原因 64% 是 "All labels exhausted"（整 | pipeline/heart/decision.ts |
| timing | `OPEN_THREADS_ENABLED` | false | true | 跨天的未了事：bot 答应过/在等的（"明天告诉你"），能像真人那样"对了，昨天你说那个…"。 与 scratchpad 的区别：那是 30 分钟工作记忆，这是跨天。只记**明确承诺**， 不做"记住所有对话"——那会变成让人出戏的机械回忆。 | tracking/open-threads.ts |
| timing | `REPAIR_ENABLED` | false | true | 关系修复：把"我说了句没讨好的话、之后没再提"作为事实交给模型， 由它决定要不要回去说点什么。宿主只呈现，不代发、不自动道歉。 触发信号已存在（outcome.ts 的 explicit_negative / repair_loop → 'corrected'）， 但此前没有消费方（action-b | tracking/repair.ts |
| timing | `REWARD_GATE_ENABLED` | false | true | 主动发言意愿闸（reward model）：主动开口前用一次便宜的 judge 判断 "现在发这句话合不合适"。原作者注释：取代扁平概率、针对主动 bot 的 头号失败模式（不合时宜地打断）。fail-OPEN：闸门故障绝不让 bot 变哑。 此前硬编码 true 但零调用方；2026-09-19  | pipeline/reward/reward-model.ts |
| timing | `ROOM_AWARENESS_ENABLED` | false | true |  | subagent/room-awareness.ts |
| timing | `SEMANTIC_DUP_ENABLED` | false | true | 语义重复守卫：bot 在同一任务里把同一个意思换个说法再发一遍（同义改写刷屏）。 字面 bigram Jaccard ≥0.85 的 anti-repeat 抓不到这种（实测相似度仅 0.13~0.27）， 所以这里用 TypeSafe System One (Jev) 问一个 Noul。仅在第 2 | subagent/host-api.ts |
| timing | `SEND_PACING_FACT_ENABLED` | false | true | sendText 回执带上"距上一条仅 N 秒"的事实注记，让模型自己意识到在连发/同义改写。 不拦截、不扣分——只给事实，改不改由 persona 决定（2026-09-19 困困问候连刷 6 条事件）。 | subagent/host-api.ts |
| timing | `SKILL_PRUNE_ENABLED` | false | true | 回收超期未验证的 skill 提案（proposed > 30d → rejected）。 prune.ts 自称"幂等，可定期跑"但零调用方；接在 skill-consolidate（写提案的地方）。 | cron/skill-consolidate.ts |
| timing | `TIMING_GATE_ENABLED` | false | true | ── Timing Gate (MaiBot-style: debounce + state machine + LLM gate) ── 全局开关。关闭时所有 timing 模块退化为透传，行为等价于改造前。 | meta/dispatch-gate.ts, meta/timing-adapter.ts, pipeline/stages/bookkeeping.ts, pipeline/stages/post-judge.ts |
| timing | `TIMING_GATE_LLM_ENABLED` | true | None | gate 的 LLM 分支开关。false = 所有确定性层原样保留，走到 LLM 之前直接 continue。 实测依据：324 次调用 199 次解析失败(61%)，成功里 124/125 是 no_action （理由清一色同一条规则的改写）。token 占比仅 ~0.2%，省 token 不 | pipeline/timing/gate.ts |
| timing | `TIMING_GATE_PRECHECK_ENABLED` | false | true | 确定性前置检查：烧 LLM 之前先判定"这条明显是群友之间在聊、与 bot 无关"。 依据 2026-09-18 实测：gate 的 LLM 分支 121/122 给出同一个 no_action， 理由全部命中 timing-gate.md 里那条显式规则（"群友彼此在聊 → 别硬挤"）。 保守设计 | pipeline/timing/gate.ts |
| timing | `TRENCH_DEBT_ATTENTION_ENABLED` | false | true | 定向债 → 注意力权重（论文 §九·补六 实验 B）。默认关。 实测：债被 Frame 呈现但 0/28 进入选择。这一条把债接到**选择侧**：来自债主的消息 在注意力累加时获得 +DEBT_ATTENTION_BOOST 压力。宿主侧确定性加权，不改模型。 | bot/handlers/message.ts |
| timing | `TRENCH_DEBT_ENABLED` | false | true | Nyat Trench 定向债：睡眠期按**发送者**记"欠谁一句"，醒来只准对那个人兑现。 评审 3 的反对意见：无方向的睡眠积压醒来后只被半衰期压平（时钟驱动=痉挛签名）， 有方向则被"还债"驱动（闭环驱动=活人）。速率上界仍由标量 P 决定，不改积分器。 | nyatos/debt.ts |
| timing | `TRENCH_ENVELOPE_ACTIVITY_SCALED` | true | true | 突发上限按群活跃度缩放。对应用户原话："日常都有点过高频率，只有在群友 活跃度高的时候高活跃"。此前上限是扁平常量——冷清群和热聊群共用一个天花板， 于是 Quiet 群里 bot 照样能每小时主动插 20 次。  缩放用宿主**本来就在测**的 xxb:activity:{chatId}（每条入站 | nyatos/envelope.ts |
| timing | `TRENCH_GATE_ENABLED` | false | true |  | cron/unified-tick.ts, subagent/host-api.ts |
| timing | `TRENCH_PUMP_ENABLED` | false | true |  | cron/scheduler.ts |
| timing | `TRENCH_SLEEP_PULSE_ENABLED` | false | true | Nyat Trench L0 × 睡眠：读到的但没法回的消息记成气压（0.5/条）。 此前这段积累完全不存在——睡眠时段消息进 pending 队列，醒来时 P=0， bot 像什么都没发生过。加上之后醒来后气压偏高 → 速率上限被 g(P) 抬高， 即"睡一觉错过一场对话，醒来头几句是密的"，之后 | bot/handlers/message.ts |
| turn | `ANTI_REPEAT_ENABLED` | false | true | G13: 发送前反重复守卫（与自己最近消息相似度 > 阈值时带约束重生成一次）。 | pipeline/reply/anti-repeat.ts, pipeline/reply/reply.ts |
| turn | `HEART_ENABLED` | false | true | G8/S13 心流:L0 未命中的被动群消息,judge L1/L2 + gate 合并为一次 带人格+自我状态的"心流判断"(reply/wait/pass)。1 次调用替代 1-3 次。 | meta/heart-adapter.ts, pipeline/heart/heart.ts, pipeline/pipeline.ts, pipeline/stages/post-judge.ts |
| turn | `HEART_REFLECT_ENABLED` | false | true | 不改决策(act/path)、不换模型;失败/超时保底用原念头。只在 reply 轮加一次调用。默认关。 | pipeline/heart/decision.ts |
| turn | `META_HEART_ENABLED` | true | None | Nyat Trench Phase 1：Meta heart（meta/heart-adapter.ts）的旁路开关。 它实测是实际做抑制的那层（12,009 次判定只放行 7.7%）；影子想 speak 85.6%。 false = 旁路它的 allow/silence，消息按既有 layer 分 | **无人读** |
| turn | `MTM_ENABLED` | false | true | ── 中期记忆(MaiBot 1.0.0 借鉴):ctx 滚出窗口前压缩成可引用摘要 ── | pipeline/context/mid-term.ts |
| turn | `PLANNER_AGENTIC_ENABLED` | false | true | ── Agentic planner（MaiBot 1.0.0 Maisaka 多轮 plan→act 借鉴）── 开了之后 planned 路径用 generateText({tools,maxSteps}) 原生工具循环, 工具结果回写 LLM 历史,可自适应换工具/重查;失败自动回退旧 JSO | pipeline/reply/reply.ts |
| turn | `SEND_IMAGE_TOOL_ENABLED` | false | true | SEND_IMAGE 工具(把上下文里的图转发出去,唯一有出站副作用的 agent 工具)。 | pipeline/tools/registry.ts |
| turn | `TURN_ABORT_ENABLED` | false | true | G3: 新消息打断在飞生成并带新上下文重规划。 | pipeline/turn/abort-registry.ts, pipeline/turn/actor.ts |
| turn | `TURN_ACTION_PLANNER_ENABLED` | false | true | G2: 统一动作空间 planner（reply/react/sticker/silent/wait）。 | pipeline/reply/prompt-builder.ts, pipeline/stages/bookkeeping.ts, pipeline/stages/deliver.ts |
| turn | `TURN_ACTOR_ENABLED` | false | true | ── Turn Actor (MaiBot MaiSaka 式 per-chat 认知回合; docs/turn-actor/) ── 全部默认关闭。关闭时 ingress/pipeline 行为与改造前完全一致。 G1: per-chat 回合 actor。开启后消息进 xxb:pending:{ | pipeline/multiagent/flags.ts, pipeline/turn/flags.ts |
| turn | `TURN_BURST_JUDGE_ENABLED` | false | true | G4: judge/gate/reply 以整个 burst 为决策单元（而非只看最后一条）。 | pipeline/pipeline.ts, pipeline/stages/deliver.ts |
| turn | `TURN_EXEC_LOCK_ENABLED` | false | true | G12 执行期互斥:runChatTurn 入口 per-chat Redis 锁,堵死"多生产者并发 scheduleTurn 造出双回合 → registerGeneration supersede 互杀 → replan 预算白烧"的竞态(2026-07-04 诊断:毫秒级成对 replann | pipeline/turn/actor.ts |
| turn | `TURN_FOCUS_ENABLED` | false | true | G9: per-chat focus/能量标量（调制判断门槛、防抖、打字节奏）。 | pipeline/heart/heart.ts, pipeline/pipeline.ts, pipeline/stages/deliver.ts, pipeline/stages/post-judge.ts |
| turn | `TURN_GATE_DEFER_COOLDOWN` | false | true | （TURN_UNIFIED_DECISION_ENABLED 2026-09-21 删除：全仓库（src/scripts/packages/tests，含 .sh）无一处读取。注释说"留着防 .env 报错"，但 zod 对未知键是剥离不是报错，那个理由不成立） gate no_action 冷却语 | pipeline/heart/heart.ts, pipeline/timing/gate.ts |
| turn | `TURN_MULTI_ANCHOR_ENABLED` | true | None | 多锚点:burst 按"发送者"分组,每组各自 judge→reply(flat 群里"线程"≈"人")。 治"只回最后一条→像回错人":每人各自回,reply_to 自然指向那个人。单人 burst(groups.size===1)走原单锚点逻辑,零回归。 | pipeline/turn/actor.ts |
| turn | `TURN_PROACTIVE_ENABLED` | false | true | G11: idle/proactive cron 经 turn actor 走完整人格管线。 | cron/sleep-cycle.ts |
| turn | `TURN_SELF_FOLLOWUP_ENABLED` | false | true | G6: 发完后自我接话（"对了…"/补贴纸），新用户消息立即终止。 | pipeline/stages/deliver.ts, pipeline/turn/self-continue.ts |
| turn | `TURN_UNANSWERED_REVISIT_ENABLED` | false | true | G7: 回访最近未回应的消息（注入 ≤2 条候选目标）。 | pipeline/stages/deliver.ts |
| turn | `TURN_WAIT_PER_PERSON` | true | None | per-person WAIT 抑制:wait 只抑制触发者集合(waitTriggerUids)的后续,别人 照常进多锚点 judge。心流 wait 本意就是"等TA说完",抑制整群是过度抑制。 同回合多人触发 wait → 都进集合,都被抑制(L1)。 | pipeline/turn/actor.ts |
| turn | `TURN_WAIT_RESUME_ENABLED` | false | true | G5: wait 到期后带锚点重入回复路径（而非只解除屏蔽）。 | pipeline/heart/heart.ts, pipeline/stages/post-judge.ts, pipeline/timing/chat-runtime.ts |

## 关着的布尔旗标（29 个）

| 段 | flag | 默认 | .env | 是什么（注释摘要） |
|---|---|---|---|---|
| core | `AGENCY_CODEACT_TRANSPORT_ENABLED` | false | — | Explicit authority-only CodeAct queue binding. Shadow/advisory/canary keep the legacy host path; authority rejects instead of silently bypassing it. |
| core | `AGENCY_LEGACY_REPLY_OBSERVATION_ENABLED` | false | — | Record successful legacy Reply deliveries as observed Agency outcomes. This never dispatches or sends; keep it opt-in until the ledger is sized. |
| core | `AGENCY_REPLY_TRANSPORT_ENABLED` | false | — | Explicit authority-only Reply text binding. Authority failures never fall back to legacy sender.sendDirect; keep the rollout opt-in. |
| core | `AGENCY_WAIT_TRANSPORT_ENABLED` | false | — | Explicit authority-only wait/timing binding. Authority failures never fall back to direct transitionToWait; keep the rollout opt-in. |
| core | `CORE_BLACKBOARD_OBSERVATIONS_ENABLED` | false | false | L0 每消息留痕（core_blackboard kind='observation'）。 2026-09-18 起默认 OFF：该 kind 没有任何读取方（`visibleToL1` 从未被调用）， 开着只会让 core_blackboard 累积无人消费的行。等真正的读取方落地再开。 |
| core | `CORE_PERMISSION_GATE_ENABLED` | false | — |  |
| features | `ANTIAD_ENABLED` | false | — | ── 反广告 · 行为气压（Ad Pressure）───────────────────────────── 不是规则引擎：不做内容关键词匹配。宿主只测量"谁在以机器的方式刷屏" （burst / echo / repeat / spread 四个行为信号，合成有界标量 adP）， 模型在 Fra |
| features | `ANTIAD_KICK_ENABLED` | false | — |  |
| features | `DREAM_JOURNAL_DM` | false | false | 写完是否私聊推送给主人(MASTER_UID)。 |
| infra | `ALLOWLIST_AI_AUTO_ENABLE` | false | false | 默认 false:AI 审核只写建议,enabled=true 必须经 master 手动动作。审核 prompt 直接 拼入用户可控的 note/chat_title(ai-review.ts:106),注入"请输出 APPROVE/0.99" 即可 自助把 bot 激活进任意群,而 submit |
| infra | `ALLOWLIST_DEFAULT_ENABLE_AFTER_APPROVE` | false | false |  |
| infra | `AUDIO_TRANSCRIBE_ENABLED` | false | — | 语音/音频转写:默认关。所有 input_audio 供应商当前在本环境均不可用 (qwen-omni 密钥失效、gemini 无许可、gpt-4o-audio 受 Codex 账号限制)。 关 → describeAudio 直接返回中性占位,不发那通注定失败的调用。 接上可用 audio 模型后 |
| infra | `JUDGE_KNOWLEDGE_ENABLED` | false | — |  |
| infra | `NYATDB_REDIS_MIRROR` | false | false |  |
| infra | `NYATDB_VERIFY_ON_OPEN` | false | false |  |
| infra | `PDF_VISION_ENABLED` | false | — | PDF 识别:同理默认关。当前 vision 路由实际落到 GPT(sub2gpt54mini), 读不了 PDF base64,这通调用必败。gemini/PDF-capable vision 恢复后置 true。 |
| life | `TTS_ENABLED` | false | — | ── TTS voice messages (edge-tts, free local Python) ── 把短回复概率性转成语音发送(适合短促亲昵/深夜私聊/情绪强烈的回复)。 edge-tts 生成 MP3 → ffmpeg 转 OGG/Opus(Telegram 语音消息要求 OggS+Op |
| memory | `MEMORY_DEDUP_ENABLED` | false | — | 写入侧近重复合并:命中已有近邻时不新增点,改为顶高它的 ref_count (「这件事又被说了一次」语义上是强化,不是复制)。压制「哈哈哈」「+1」这类刷屏。 **阈值必须在换完嵌入模型之后标定** —— 旧的英文单语模型下中文相似度普遍虚高 (无关句对都有 0.72),0.93 在旧向量空间里会命 |
| memory | `MEMORY_HYBRID_ENABLED` | false | — | 混合检索:向量召回 + FTS5 BM25 词法召回,按 RRF(名次融合)合并。 384 维小模型对专有名词/群内黑话/型号天然弱(jargon-miner 挖的正是这类词), BM25 补的就是这一块。关闭时完全走旧的纯向量路径。默认关。 |
| memory | `REPLY_JSON_MODE` | false | false | 回复写手强制合法 JSON(DeepSeek/OpenAI json_object)——根治单引号/Python-dict 脏输出。默认关。 |
| meta | `DEBT_SEMANTIC_MATCH_ENABLED` | false | — | Optional host-owned semantic ranking after deterministic debt matching. It never resolves debt and is deliberately off until cost/quality is measured. |
| self | `DEEP_THINK_ENABLED` | false | false | 「深想」:群里 @bot / 回复 bot 的**硬技术问题**,正常回复照常,同时后台丢给 mundo 深推理,想好了补发一条「我仔细想了下:…」。只对直接问 + 廉价判定为硬技术 的触发(低频),失败/回退/空则不补发(静默)。默认关;依赖 MUNDO_ENABLED。 |
| self | `MUNDO_ENABLED` | false | false | ── Mundo「难题攻坚」部门(可选,默认关)──────────────────────────────── 第三方自建端点上的深推理模型(qwen3.6/映射 Mundo AI),擅长硬算法/并发/调试, 但延迟高、极耗 token、可能空转、端点自签证书不稳定 —— 只适合离线非关键任务且  |
| self | `STEPFUN_CONSUMER_ENABLED` | false | false | ── StepFun 配额消费引擎(用户选:滚动深反思)────────────────────────── 专用后台引擎:持续对全量群做大窗口深反思 + 跨上下文画像合并,把 8000M/月订阅 用起来(冲 ~100M/天)。默认关。日调用数 ≈ CALLS_PER_TICK × 1440(每分钟 |
| social | `MULTI_AGENT_CRITIC_ON_LOOKUP` | false | false |  |
| social | `MULTI_AGENT_ENABLED` | true | false | ── Multi-Agent 协调(Orchestrator + 专家 + Writer)── 把"一个 agent 拿所有工具"拆成"几个专职专家并行 + Writer 收口"。 Router 复用 judge.replyPath(direct→chat 跳过专家,planned→lookup/d |
| social | `MULTI_AGENT_ROUTE_CONVERGENCE_ENABLED` | false | — | Route-convergence experiment: for an explicit allowlist, direct/fast replies stop spawning chat specialists; deep/lookup keep only work justified by t |
| social | `PROACTIVE_COORDINATOR_ENABLED` | false | — | ── P2-A: 主动搭话统一调度 ── 防止 idle + proactive-scan 同时对同一群发消息；全局每群每小时上限 |
| social | `PROACTIVE_MEMORY_ENABLED` | false | — | ── P2-A: 主动搭话记忆驱动 ── 主动发言时搜索 Qdrant 群聊记忆，注入"上次聊过的相关话题" |

## 非布尔参数（272 个）

| 段 | key | 默认 | .env | 是什么（注释摘要） |
|---|---|---|---|---|
| cognition | `DISTILL_USAGE` | 'summarize' | — | ── AGI Level 4 P4-A: 经验沉淀（常驻）───────────────────────────────── 任务终态复盘蒸馏成 episode + 可复用经验；开工前按 contentDirection 检索相关经验注入  |
| cognition | `DREAM_CONSOLIDATE_USAGE` | 'judge' | judge |  |
| cognition | `EXPERIENCE_VERIFY_MIN_SUCCESS` | 2 | 2 |  |
| cognition | `GROUP_NORMS_INFER_USAGE` | 'judge' | judge |  |
| cognition | `GROUP_NORMS_TTL_HOURS` | 6 | 6 |  |
| cognition | `HOBBY_DISTILL_USAGE` | 'summarize' | — |  |
| cognition | `LOOP_POLICY_MAX` | 5 | 5 |  |
| cognition | `RECALL_MAX_EXPERIENCE` | 3 | 3 |  |
| cognition | `SKILL_CONSOLIDATE_USAGE` | 'judge' | — |  |
| cognition | `SKILL_DISTILL_INTERVAL_MIN` | 360 | — |  |
| cognition | `SKILL_DISTILL_USAGE` | 'summarize' | — |  |
| cognition | `SKILL_MAX_BIG` | 50 | — |  |
| cognition | `TASK_MAX_ROUNDS` | 6 | — |  |
| core | `AGENCY_CANARY_CHAT_IDS` |  | — |  |
| core | `AGENCY_MAX_LLM_CALLS` | 2 | — |  |
| core | `AGENCY_MAX_TOOL_CALLS` | 8 | — |  |
| core | `AGENCY_RUNTIME_MODE` | 'shadow' | — | Host-owned Agency rollout mode. The default keeps Core proposals observable without allowing them to dispatch adapters o |
| core | `BELIEF_TTL_DEFAULT_SEC` | 7776000 | — |  |
| core | `BELIEF_VIEW_INJECT_MAX` | 4 | — | Belief View 注入 prompt 的预算（Phase 2 才用，Phase 0 只定义） |
| core | `BEST_OF_N_BASE` | 1 | 4 | ── AGI Level 6 Phase 15: 小模型增强 ──────────────────────────────── best-of-N 采样基数(按难度翻倍)。verifier 用 judge usage 打分选最优。 |
| core | `COGNITIVE_CONTINUITY_INTERVAL_SEC` | 60 | 60 |  |
| core | `COGNITIVE_KERNEL_CHAT_IDS` |  | — | Kernel shadow graylist. Empty = all chats once the flag is on; set a few internal chatIds so the first rollout stays mea |
| core | `COGNITIVE_ROUTING_CHAT_IDS` |  | — |  |
| core | `CORE_DRIVE_SATIATION_HALFLIFE_SEC` | 21600 | — | Phase 6：drive satiation 半衰期（秒，默认 6h，与 norms TTL 同量级）。 halflifeSec() 经 env() 读这里（Phase 6 前直读 process.env，已收敛）。 |
| core | `CORE_V2_CHAT_IDS` | '' | — | 灰度群，逗号分隔。空 = 全量生效（与 TURN_ACTOR/MULTI_AGENT 一致）。 |
| core | `MEMORY_STALE_AFTER_DAYS` | 90 | 90 |  |
| core | `SOCIAL_ACT_SHADOW_CHAT_IDS` |  | — |  |
| features | `ANTIAD_CHAT_IDS` | '' | — |  |
| features | `CODEACT_BANNED_WORDS` |  | — | CodeAct 禁词(逗号分隔),出站文本命中则拒发并要求重写。 |
| features | `DREAM_JOURNAL_CHAT_ID` | 0 | 3954993432 | 日记发布频道/群 chatId。正数会规范成 -100{id}(超群/频道)；0=不发频道。 |
| features | `DREAM_JOURNAL_CRON` | '0 23 * * *,0 15 * * *' | 0 23 * * *,0 4 * * *,0 15 * * * | 一个或多个 cron(UTC,逗号分隔)。默认:23:00 UTC=北京07:00(早)、15:00 UTC=北京23:00(睡前)。 模型可 WRITE/SKIP；一天多段追加，无次数上限。也可用 sleep 边沿触发。 |
| features | `DREAM_JOURNAL_DIR` | './data/dream-journal' | ./data/dream-journal |  |
| features | `DREAM_JOURNAL_USAGE` | 'reply' | reply |  |
| features | `EXPRESSION_INJECT_COUNT` | 5 | 3 |  |
| features | `JARGON_INFERENCE_THRESHOLDS` | '3,8,25,100' | — | G1: 首档 4→3,黑话冷启动更快过推断线(重检计数修复后才有意义) |
| features | `LEARNER_BATCH_SIZE` | 80 | — |  |
| features | `LEARNER_MAX_CHATS_PER_TICK` | 3 | 3 |  |
| features | `LEARNER_MIN_NEW_MSGS` | 30 | 30 |  |
| features | `LEARNER_SCAN_INTERVAL_MIN` | 60 | 60 |  |
| features | `LEARNER_SCAN_USAGE` | 'judge' | — |  |
| features | `SANDBOX_ALLOWED_COMMANDS` | '' | — |  |
| features | `SANDBOX_BLOCKED_COMMANDS` | 'rm -rf,shutdown,reboot,mkfs,halt,dd if=,chmod 777' | — |  |
| features | `SILENCE_ALERT_CHAT_ID` | 0 | 6251541967 | 告警目标(owner DM chatId,正数)。0=只打日志不发送。 |
| features | `SILENCE_ALERT_COOLDOWN_MIN` | 120 | 120 | 同一 chat 两次告警的最小间隔(去重,防刷屏)。 |
| features | `SILENCE_ALERT_HUMAN_STALE_MIN` | 60 | 60 | 人类最后发言距今超过该分钟数 = 不算活跃(潜水群不告警)。 |
| features | `SILENCE_ALERT_INTERVAL_MIN` | 5 | 5 | 扫描周期(分钟)。 |
| features | `SILENCE_ALERT_MAX_PER_RUN` | 5 | 5 | 单轮最多告警几个 chat(防告警风暴)。 |
| features | `SILENCE_ALERT_THRESHOLD_MIN` | 30 | 30 | bot 最后回复距今超过该分钟数 = 判定沉默。 |
| features | `STEPFUN_SEARCH_API_KEY` | '' | mCv500Dxe2hrBrWoz4Zo2VivSn5llYY4lWzrMX7Q |  |
| features | `STEPFUN_SEARCH_BASE_URL` | 'https://api.stepfun.com' | — |  |
| features | `STEPFUN_SEARCH_CATEGORY` | '' | — |  |
| features | `STEPFUN_SEARCH_MAX_RESULTS` | 5 | — | stepfun 不认 max_results（恒返回 10 条），所以在客户端切。 |
| features | `TIC_PENALTY_INTERVAL_MIN` | 30 | — |  |
| features | `TIC_PENALTY_MIN_FRACTION` | 0.35 | — |  |
| features | `TIC_PENALTY_MIN_MESSAGES` | 4 | — |  |
| features | `TIC_PENALTY_TTL_SEC` | 6 * 3600 | — |  |
| features | `TIC_PENALTY_WINDOW` | 60 | — |  |
| infra | `ALLOWLIST_AI_CONFIDENCE_THRESHOLD` | 0.85 | 0.85 |  |
| infra | `ALLOWLIST_AI_CONTEXT_MAX_CHARS` | 24000 | 24000 |  |
| infra | `ALLOWLIST_AI_MESSAGE_LIMIT` | 100 | 100 |  |
| infra | `ALLOWLIST_MAX_SUBMISSIONS_PER_DAY` | 20 | 20 |  |
| infra | `ALLOWLIST_REDIS_PREFIX` | 'xxb:mal:' | xxb:mal: |  |
| infra | `BOT_NICKNAMES` |  | 啾咪囝,啾咪 |  |
| infra | `BOT_TOKEN` |  | 8392759490:AAGBDKIKf9tlJ-PfZSHznuu2p2v0u | Telegram |
| infra | `BOT_USERNAME` | 'xxb_bot' | hunhebi_bot |  |
| infra | `CHANNEL_SOURCE_IDS` |  | — | Channel source IDs — channel posts from these channels are ingested into ChromaDB as knowledge |
| infra | `CHANNEL_SOURCE_USERNAMES` |  | zaihuapd | Public channel usernames to scrape (no admin needed, uses t.me/s/ web page) |
| infra | `COMMON_API_KEY` |  | 74be0b744820a1501488f99b558f71d61c199f56 |  |
| infra | `CONTEXT_MAX_LENGTH` | 600 | 400 |  |
| infra | `FETCH_GATEWAY_URL` |  | — |  |
| infra | `FETCH_WORKER_URL` |  | — |  |
| infra | `FIRECRAWL_API_KEY` |  | self-hosted | Firecrawl 兜底:JS 重页面 / Cloudflare 验证页,免费路由(直连/Jina/本地绕过) 全失败后才落到这条付费路由。未配 KEY → 默认关,不发任何 Firecrawl 调用。 |
| infra | `FIRECRAWL_API_URL` | 'https://api.firecrawl.dev' | http://127.0.0.1:3002 |  |
| infra | `GEMINI_API_KEY` |  | AIzaSyDxs8XRVUzn2-HqA6x73L97qjxXc-qodJo | Gemini 联网搜索(Google Search grounding,AI Studio key)。配 KEY 即为主搜索路由。 注:3.1-flash-lite 的 grounding 在免费 key 上 quota=0(需计费);2. |
| infra | `GEMINI_SEARCH_MODEL` | 'gemini-2.5-flash-lite' | gemini-2.5-flash-lite |  |
| infra | `GEMINI_SEARCH_PROXY` |  | http://127.0.0.1:1081 | 本机真实出口地区不支持 grounding(400 User location not supported);设代理只让 Gemini 搜索这一路走代理(其余流量直连,免得 Redis/Qdrant/Firecrawl 等本地连接被绕)。 |
| infra | `GLOBAL_FETCH_PROXY` |  | http://127.0.0.1:1081 | KVM 等受限网络：设 GLOBAL_FETCH_PROXY 后，所有外网 fetch 经 undici ProxyAgent 走代理（Telegram Bot API / LLM / Gemini / web-fetch），本地地址自动直 |
| infra | `HEDGE_DELAY_MS` | 2000 | 0 | AI tuning |
| infra | `HOST` | '0.0.0.0' | 0.0.0.0 |  |
| infra | `IP_QUALITY_API_URL` |  | — |  |
| infra | `JUDGE_WINDOW_SIZE` | 10 | 30 |  |
| infra | `KNOWLEDGE_BASE_DIR` | './data/knowledge' | — | Knowledge base (file-backed, PHP parity) |
| infra | `KNOWLEDGE_CRON_CHAT_IDS` |  | — | Knowledge cron (cron_long_term.php parity) |
| infra | `KNOWLEDGE_CRON_HASH_PATH` |  | — |  |
| infra | `KNOWLEDGE_CRON_SCHEDULE` | '30 * * * *' | — |  |
| infra | `LOG_LEVEL` | 'info' | info |  |
| infra | `MASTER_UID` | 0 | 6251541967 | Business |
| infra | `MASTER_UID_EXTRA` |  | — |  |
| infra | `NODE_ENV` | 'development' | production |  |
| infra | `NYATDB_CHAT_RING_MAX` | 200 | 200 |  |
| infra | `NYATDB_MAX_MESSAGES_PER_CHAT` | 5000 | 5000 |  |
| infra | `NYATDB_PATH` | './data/nyatdb' | ./data/nyatdb |  |
| infra | `NYATDB_POOL_FRAMES` | 64 | 128 |  |
| infra | `NYATDB_SYNC_EVERY` | 8 | 8 |  |
| infra | `PERSONA_DIR` |  | — | Persona override directory (per-user {uid}.md / .txt) |
| infra | `PORT` | 3000 | 3001 | Server |
| infra | `QDRANT_HOST` | '127.0.0.1' | 127.0.0.1 | Qdrant (vector memory) — zod-coerced; a non-numeric QDRANT_PORT now fails validation at startup instead of producing `po |
| infra | `QDRANT_PORT` | 6333 | 6333 |  |
| infra | `QUEUE_CONCURRENCY` | 8 | 8 | Queue |
| infra | `RATE_LIMIT_PER_MIN` | 30 | 60 | Rate limiting |
| infra | `REDIS_URL` | 'redis://127.0.0.1:6379/0' | redis://127.0.0.1:6379/5 | Redis |
| infra | `SEARXNG_URL` |  | — |  |
| infra | `SKILLS_DIR` | './data/skills' | — | Tool System |
| infra | `SQLITE_PATH` | './data/xxb.db' | ./data/xxb.db | SQLite |
| infra | `TIMER_API_URL` |  | — |  |
| infra | `TIMER_CALLBACK_URL` |  | — |  |
| infra | `VIDEO_DESCRIBE_MAX_TOKENS` | 2000 | 2000 | reasoning 计入 completion:给小了会拿到空正文(实测 max_tokens=400 → 空)。 |
| infra | `VIDEO_DESCRIBE_TIMEOUT_MS` | 120_000 | 120000 |  |
| infra | `VIDEO_MAX_DURATION_SEC` | 300 | 300 | 视频时长硬上限（秒）。模型侧 5 分钟；Telegram 侧还有更紧的 20MB 下载上限 （代码里 MAX_MEDIA_BYTES=10MB），5 分钟视频几乎必然超——所以现实里能描述的 是短视频。超限的不下载，直接给带时长的中性占位。 |
| infra | `WEBHOOK_SECRET` |  | 2a6242aa7e21c38b6982a7fe8e7a0159c678c4e2 |  |
| infra | `WEBHOOK_URL` |  | — | Webhook (optional — use polling if not set) |
| infra | `WEB_FETCH_USER_AGENT` | 'XXB-WebFetch/1.0' | XXB-WebFetch/1.0 |  |
| infra | `XAI_API_KEY` |  | — |  |
| infra | `XAI_SEARCH_BASE_URL` | 'https://new-api-zhcm.onrender.com/v1' | — |  |
| infra | `XAI_SEARCH_MODEL` | 'grok-4.3-fast' | — |  |
| judge | `JUDGE_SUBSTRATE_BACKEND` | 'typesafe' | typesafe |  |
| judge | `JUDGE_SUBSTRATE_BREAKER_COOLDOWN_MS` | 60000 | — |  |
| judge | `JUDGE_SUBSTRATE_BREAKER_FAILS` | 3 | — |  |
| judge | `JUDGE_SUBSTRATE_CACHE_TTL_MS` | 120000 | — |  |
| judge | `JUDGE_SUBSTRATE_TIMEOUT_MS` | 9000 | 9000 | 3000 → 9000。2026-09-21 实测：typesafe（jev-latest，一个 reasoning 模型） 的延迟是 1.1 / 1.3 / 3.3 秒——**第 3 次就超了 3000ms**。 于是每三次里约一次超时  |
| judge | `NO_ACTION_BACKOFF_CAP_SEC` | 300 | 60 |  |
| judge | `NO_ACTION_BACKOFF_START_COUNT` | 2 | — | no_action 指数退避(MaiBot 借鉴):窗口 = base * 2^max(0, n-START), 即第 START_COUNT+1 次 no_action 起开始翻倍,封顶 CAP;continue/真实 回复清零计数。 |
| judge | `REFLECTION_CHATS_PER_TICK` | 20 | 15 |  |
| judge | `REFLECTION_INTERVAL_MIN` | 30 | 10 |  |
| judge | `REFLECTION_TICK_BUDGET_SEC` | 180 | — | 单个反思 tick 的墙钟预算（秒）。超时的群跳过，下一个 tick 自然补上。 2026-09-21：没有它时，waitIfCooling（round 55）+ 每跳 20s（round 53） 能把一个 tick 拖到 629s，而 t |
| judge | `REFLECTION_USAGE` | 'summarize' | reflection |  |
| judge | `REFLECTION_WINDOW_MSGS` | 250 | 200 |  |
| judge | `TIMING_CONTINUATION_WINDOW_SEC` | 180 | — |  |
| judge | `TIMING_GATE_COOLDOWN_SEC` | 15 | — | 阶段 4：gate 选 wait/no_action 后，下次再调 gate 的冷却时间（秒）。 对应 MaiBot 的 timing_gate_non_continue_cooldown_seconds。 |
| judge | `TIMING_GATE_MAX_TOKENS` | 1200 | 1200 | gate LLM 的 max_tokens。  2026-09-21 修：这里原来是**调用点写死的 200**，而 gate 的 usage 现在是 `reflection` → stepfun = step-3.7-flash，一个 * |
| judge | `TIMING_GATE_TIMEOUT_MS` | 8000 | 20000 |  |
| judge | `TIMING_TALK_VALUE` | 1.0 | 0.3 | P1-C talk_value 频率阈值(0..1]:1.0 = 该层关闭(no-op)。<1 时非直接消息需攒 ceil(1/有效值) 条才评一次 gate,未达阈值 → defer 延迟重评;有空闲补偿兜底。 per-chat Redi |
| judge | `TIMING_WAIT_MAX_SEC` | 120 | — | 阶段 4：wait 工具最大允许秒数；超过会被裁剪。 |
| judge | `TIMING_WAIT_MIN_SEC` | 5 | — |  |
| judge | `TOPIC_SCAN_TICK_BUDGET_SEC` | 180 | — | topic-scan 单个 tick 的墙钟预算（秒）。同 REFLECTION_TICK_BUDGET_SEC 的理由： extractTopic 原来没设每跳上限，用 judge usage 的 120s，20 群 × 3 跳 = 理论 |
| judge | `TURN_GATE_DEFER_MAX_REPLAYS` | 1 | — | P0-B defer=延迟重评:同一条消息最多被 defer 重排几次(超限按旧语义静默丢弃)。 |
| life | `ADMIN_CORS_ORIGINS` |  | https://miniapp.gomami.wiki | Admin |
| life | `DAILY_LIFE_PROFILE` | 'auto' | auto |  |
| life | `DM_GREET_AFFINITY_MIN` | 40 | — |  |
| life | `DM_GREET_MAX_USERS` | 2 | — |  |
| life | `DM_PROACTIVE_COOLDOWN_HOURS` | 20 | — |  |
| life | `MONITOR_TOKEN` | '' | xxb2026monitor | Monitor |
| life | `MOOD_DECAY_RATE_PER_HOUR` | 0.3 | — | 每小时衰减比例 (0..1)。0.3 = 1 小时后保留 70% 强度 |
| life | `MOOD_INJECT_THRESHOLD` | 20 | 20 | \|valence\| < 该阈值时不注入 prompt（默认 calm 不打扰） |
| life | `NYATOS_BUDGET_MAX_ACTS` | 6 | 6 |  |
| life | `NYATOS_BUDGET_MIN_GAP_ADDRESSED_SEC` | 30 | 30 | 两次**被叫到**的回复之间的最小间隔（秒）。  2026-09-21 补上这条的原因：原来最小间隔只拦主动发言，而被叫到的那条路 （生产流量几乎全带引用锚点）**一点间隔都没有**。实测近 3 天 3008 次群发送： 小时窗 p50=6 |
| life | `NYATOS_BUDGET_MIN_GAP_SEC` | 90 | 90 | 两次主动发言之间的最小间隔（秒）。计数额度挡不住"1 分钟连发 6 条"—— Phase 2.3 实测的 48 次/28 分钟、中位间隔 7 秒正是这个形状。 这是"我刚说过，让别人说"的那一半，与计数额度互补。0 = 关闭。 |
| life | `NYATOS_BUDGET_WINDOW_SEC` | 3600 | 3600 |  |
| life | `NYATOS_SHADOW_CHAT_IDS` |  | -1002750574953,-1003184176508,-100382109 | 影子判断的灰度群（空 = 开启后全量）。影子每次会多一次 LLM 调用， 先限定内部群可以把成本与干扰都控制住。 |
| life | `NYATOS_SHADOW_TIMEOUT_MS` | 20_000 | 20000 |  |
| life | `PHP_WEBHOOK_URL` |  | — |  |
| life | `RELATIONSHIP_INJECT_THRESHOLD` | 20 | 20 | \|affinity\| < 该值时不注入 prompt（默认 一般 关系不打扰） |
| life | `RESIDENT_STICKER_PACKS` |  | kawaiikipfel_by_moe_sticker_bot,NekoBia | 常驻贴纸包(逗号分隔的贴纸包 set_name):作为 bot 主力贴纸,选择时占多数候选槽。 |
| life | `SELF_HISTORY_INJECT_LIMIT` | 5 | 5 |  |
| life | `SELF_HISTORY_WINDOW_DAYS` | 30 | — |  |
| life | `SELF_HISTORY_WINDOW_MIN` | 45 | — | 心流看到的"近况"窗口（分钟）。只影响行为史事实块，不影响对某人的一致性注入。 |
| life | `TS_WEBHOOK_URL` |  | https://hunhebi.sharon.wiki | Cutover (optional — only used by scripts/cutover.sh) |
| life | `TTS_VOICE` | 'zh-CN-XiaoxiaoNeural' | — | edge-tts 语音名(中文默认晓晓;也可换 zh-CN-XiaoyiNeural 等)。 |
| memory | `CACHE_WARMUP_INTERVAL_MIN` | 4 | — |  |
| memory | `MEMORY_COLLECTION` | 'xxb_group_history' | xxb_group_history_v2 |  |
| memory | `MEMORY_DEDUP_THRESHOLD` | 0.93 | — |  |
| memory | `MEMORY_EMBED_MODEL` | 'Xenova/all-MiniLM-L6-v2' | Xenova/paraphrase-multilingual-MiniLM-L1 | ── 长期记忆嵌入模型 / collection / 相关性下限 ────────────── 默认的 all-MiniLM-L6-v2 是**英文单语**模型,而本 bot 是中文群聊。生产机实测中文 同义 0.7543 / 无关 0.6 |
| memory | `MEMORY_MIN_SCORE` | 0 | — | 检索相关性下限(0..1)。0 = 不过滤,保持历史行为(纯 topK)。 换模型与调阈值刻意分成两次改动;标定必须用真实语料,别沿用旧模型下的经验值。 |
| memory | `MEMORY_SENSITIVE_CHAT_IDS` |  | — | 始终视作私密的会话(逗号分隔 chatId;群为负数)。DM 由 DM_AUTO_PRIVATE 自动判定。 |
| memory | `PROFILE_MERGE_CHAT_IDS` |  | — | 合并灰度群列表(逗号分隔 chatId,群为负数),空 = 对所有上下文生效。 |
| memory | `PROFILE_MERGE_USAGE` | 'summarize' | summarize | 全局画像合并走哪个便宜模型 usage 路由。 |
| memory | `REPLY_DIRECT_RECENT_WINDOW` | 30 | — | 优化:direct 模式只取最近 N 条(原 50)——砍掉不可缓存的上下文体积,降 token/延迟。 |
| memory | `SLEEP_WAKE_WINDOW_MIN` | 20 | — |  |
| memory | `SUBAGENT_MEMORY_CHAT_IDS` |  | — | 灰度名单。**空 = 关闭**,与本仓其他 flag 的「空 = 全量」刻意相反: 这是隐私相关特性,配错的代价不对称 —— 漏开只是没效果,误开是内容外泄。 |
| memory | `SUBAGENT_MEMORY_MAX_CHARS` | 600 | — |  |
| memory | `SUBAGENT_MEMORY_TIMEOUT_MS` | 400 | — | 上下界都要:下界防 `TIMEOUT-50` 变成 0 导致「记忆永远为空且与无命中不可区分」, 上界防有人调大后阻塞 CodeAct(那是生产热路径)。 |
| memory | `SUBAGENT_MEMORY_TOPK` | 3 | — |  |
| memory | `TOPIC_SCAN_INTERVAL_MIN` | 8 | — |  |
| meta | `AGENT_COMPACT_AFTER_TURNS` | 50 | — | history 超过多少轮触发 LLM 压缩早期轮次。 |
| meta | `AGENT_COMPACT_USAGE` | 'judge' | — | （AGENT_PROGRESS_PING_ENABLED 2026-09-21 删除：全仓库无一处读取，.env 里开着。 它描述的"确定性进度 ping"从未实现——真要做是个新功能，不是翻一个旧开关。） 上下文压缩用的 AI usage |
| meta | `AGENT_MAX_SEGMENTS` | 10 | — | 单个任务最多跑几段（每段 CODEACT_MAX_TURNS 轮）。超限强制诚实收尾。 |
| meta | `AGENT_TASK_SEND_BUDGET` | 6 | 6 | 单个任务**一共**最多发几条消息（跨段累计）。 2026-09-21 之前这个预算实际是"每段 6 条 × 10 段 = 60 条"——每段重建 host api 就把 textSent 归零了。实测 1555 个任务/2965 次投递， |
| meta | `ARTIST_USAGE` | 'reply' | artist | 画摊子（agent/artist.ts）的 AI usage 名：SVG 是代码活，默认跟 reply 主链。 |
| meta | `CODEACT_CONCURRENCY` | 4 | — | CodeAct BullMQ / local pump 全局并发；同 chat 仍串行（Redis active lock）。 |
| meta | `CODEACT_TIMEOUT_MS` | 30_000 | 45000 | （CODEACT_MAX_TURNS 2026-09-21 删除：全仓库（src/scripts/packages/tests，含 .sh）无一处读取。每段轮数上限是 executor.ts 里写死的 30，不是这个 8） |
| meta | `CODEACT_USAGE` | 'reply' | reply |  |
| meta | `DEBT_SEMANTIC_MATCH_MAX_CANDIDATES` | 4 | — |  |
| meta | `DEBT_SEMANTIC_MATCH_MIN_SCORE` | 0.72 | — |  |
| meta | `DEBT_SEMANTIC_MATCH_TIMEOUT_MS` | 2_500 | — |  |
| meta | `DEBT_SEMANTIC_MATCH_USAGE` | 'judge' | — |  |
| meta | `DEBT_SWEEP_INTERVAL_MIN` | 30 | — |  |
| meta | `DREAMING_CRON` | '17 19 * * *' | — | dreaming cron（UTC）。默认 19:17 UTC = 北京 03:17。 |
| meta | `GROUNDING_USAGE` | 'judge' | reflection | grounding 搜索综合用的 AI usage 名（便宜快模型）。 |
| meta | `META_ATTENTION_TOP_N` | 8 | 8 | 单次 Meta flush 最多处理几个 attention 条目。 |
| meta | `META_HEART_REFRACTORY_MS` | 45_000 | 30000 |  |
| meta | `META_L0_COALESCE_MS` | 2800 | 2800 |  |
| meta | `META_SUBAGENT_CHAT_IDS` |  | — | 灰度 chatId 列表(逗号分隔)。空 = META_SUBAGENT_ENABLED 时对所有 chat 生效。 |
| meta | `META_TICK_MS` | 5000 | 5000 | Meta tick 间隔(ms)。对齐 CGM Attention flush 窗口量级。 |
| meta | `META_USAGE` | 'judge' | judge | Meta / CodeAct 用的 AI usage 名(走现有 AI_USAGE_* 路由)。 |
| meta | `POST_TASK_FOLLOWUP_USAGE` | 'judge' | reflection | follow-up 判定用的 AI usage 名（便宜快模型）。 |
| meta | `POST_TASK_WINDOW_MS` | 120_000 | — | 发酵窗口时长(ms)。默认 2 分钟。 |
| meta | `PROMISE_CHECK_USAGE` | 'reflection' | reflection | 承诺兜底判定用的 AI usage 名（便宜快模型；LLM 判定非规则引擎）。 |
| meta | `TASK_PROGRESS_KEEPALIVE_MS` | 35_000 | — | （TASK_PROGRESS_START_DELAY_MS 2026-09-21 删除：全仓库（src/scripts/packages/tests，含 .sh）无一处读取。task-progress.ts 的节流只读 KEEPALIVE/ |
| meta | `TASK_PROGRESS_MAX_VISIBLE_UPDATES` | 6 | — |  |
| meta | `TASK_PROGRESS_MIN_INTERVAL_MS` | 30_000 | — |  |
| self | `GOAL_MAX_ACTIVE` | 20 | 20 | ── AGI Level 4 P4-B: 好奇心目标追踪（常驻）─────────────────────────── 把「值得持续关注的事」固化为 goal，unified-tick 周期性 CodeAct 查进展并汇报。 |
| self | `PROFILE_MERGE_MAX_UIDS` | 8 | 48 |  |
| self | `PROFILE_MERGE_STALE_HOURS` | 72 | 4 | （SCRATCHPAD_ENABLED 已移除——工作记忆常驻） C:profile-merge 加频 —— 合并水位线间隔(小时)+ 每 tick 处理人数,调小/调大 直接影响全局画像刷新频率与 token 消耗。 |
| self | `PROFILE_SYNC_BATCH_SIZE` | 20 | 60 | 每 tick 处理多少个"有 pending 消息"的用户画像。默认 20;调大可更快榨干 积压的 pending backlog(有意义的真实工作),也提高 StepFun 消耗。 |
| self | `RELATIONSHIP_ASYMMETRY_DOWN` | 1.5 | — |  |
| self | `RELATIONSHIP_ASYMMETRY_UP` | 0.5 | — |  |
| self | `SELF_PLAY_COOLDOWN_SEC` | 4 * 3600 | — | 两次 self-play 的最小间隔（tick 内 self_play 动作的冷却否决） |
| self | `SELF_REFLECT_USAGE` | 'judge' | — | ── AGI Level 4 P4-C: 自我模型（常驻）──────────────────────────────── 每天凌晨复盘自己 24h 的回复表现 → ≤5 条自我认知注入回复 prompt。 |
| self | `STEPFUN_CONSUMER_CALLS_PER_TICK` | 30 | 4 |  |
| self | `STEPFUN_CONSUMER_CONCURRENCY` | 4 | 1 | 并发默认 4:StepFun 账号并发上限=8 且与用户可见的 reply/judge 共享,引擎须留余量 (设过高会 429 拖累实时回复)。 |
| self | `STEPFUN_CONSUMER_REFLECT_WEIGHT` | 3 | 40 | 群深反思在工作池里的权重(重复入池次数):群内容真实演化、最不浪费,给更高权重。 |
| self | `UNIFIED_TICK_HOUR_END` | 23 | — |  |
| self | `UNIFIED_TICK_HOUR_START` | 8 | — |  |
| self | `UNIFIED_TICK_INTERVAL_MIN` | 5 | — | ── AGI Level 5 P5-A: 统一唤醒循环（常驻）─────────────────────────── 决策合并：一次 tick 一次 LLM 决定干什么（关心主人/群冒泡/自玩/查goal/安静）， 执行保留旧 cron 的 |
| self | `UNIFIED_TICK_USAGE` | 'judge' | — |  |
| social | `ASI_RUBRIC_MAX_TOKENS` | 1200 | 1200 | rubric 的 max_tokens。step-3.7-flash 是 reasoning 模型，思维链计入 completion： 实测 120/600 都只拿到空 content，1200 才出正文。别改小。 |
| social | `ASI_SAMPLE_RATE` | 0.2 | 0.2 | ASI 回复自评抽样率:1.0 = 全量(每条回复都自评),0.5 = 抽一半。 默认 0.2。ASI rubric 与 realtime-learn 的回复自评对**同一对** (trigger, reply) 各打 一次分,维度都是"贴 |
| social | `ASI_USAGE` | 'asi' | — | ASI rubric 走哪个 usage。  2026-09-21：原来硬编码 'judge'，而 judge 的 label 是 FORMAT=claude 的 stepfun → 走 callClaude（Anthropic /mess |
| social | `BOT_COMMAND_LEARN_INTERVAL_MIN` | 30 | 30 | 学习扫描间隔(分钟) |
| social | `BOT_COMMAND_LEARN_USAGE` | 'summarize' | summarize | 学习侧(把观察到的命令提炼成用法/场景)的 LLM 路由。离线 cron、不赶时间、是深 推理任务 → 正好交给 mundo(qwen3.6);设 'mundo' 需 MUNDO_ENABLED。默认走 summarize。 |
| social | `BOT_DELEGATION_COOLDOWN_SEC` | 60 | 60 | 每群代发限速(秒):两次代发最小间隔 |
| social | `BOT_REPLY_DELEGATION_COOLDOWN_SEC` | 60 | 60 | 两次回复式代发最小间隔(秒)。群管动作连着来就像机器在干活。 |
| social | `BOT_REPLY_DELEGATION_MAX_PER_HOUR` | 3 | 3 | 每群每小时回复式代发上限。超过就只观察不动手。 |
| social | `MULTI_AGENT_CHAT_IDS` |  | — | 灰度群列表(逗号分隔 chatId)。空 = 对所有群生效;非空 = 仅列出的群走多智能体。 |
| social | `MULTI_AGENT_CHECKER_TIMEOUT_MS` | 10000 | — |  |
| social | `MULTI_AGENT_CONTEXT_DIGEST_MIN_MSGS` | 12 | — |  |
| social | `MULTI_AGENT_CONTEXT_DIGEST_TIMEOUT_MS` | 8000 | — |  |
| social | `MULTI_AGENT_CRITIC_MAX_ROUNDS` | 2 | 2 |  |
| social | `MULTI_AGENT_CRITIC_TIMEOUT_MS` | 8000 | — |  |
| social | `MULTI_AGENT_DIRECTOR_TIMEOUT_MS` | 5000 | — |  |
| social | `MULTI_AGENT_PERSONA_CRITIC_TIMEOUT_MS` | 6000 | — |  |
| social | `MULTI_AGENT_RESEARCHER_MAX_STEPS` | 6 | — |  |
| social | `MULTI_AGENT_RESEARCHER_TIMEOUT_MS` | 20000 | — | 专家超时预算(与 turn 打断信号合并;超时→该专家 failed→Writer 回退内部 planner) |
| social | `MULTI_AGENT_ROUTE_CHAT_IDS` |  | — |  |
| social | `PROACTIVE_HOURLY_MAX_PER_CHAT` | 3 | — |  |
| social | `REALTIME_LEARN_TIMEOUT_MS` | 10000 | — |  |
| social | `REPLY_TOOLS_MAX_STEPS` | 4 | 4 |  |
| social | `REPLY_TOOLS_USAGE` | 'reply_tools' | — | 合并写手（reply-with-tools）用的 AI usage。它走 AI SDK 的 tools，**只吃 OpenAI 兼容格式**，而 reply 主链默认是 claude 原生格式——用同一个 usage 会让链上每个 labe |
| social | `RSS_FEEDS_JSON` | '[]' | [{"url":"https://www.geekpark.net/rss"," | JSON 数组: [{url, chatId, autoPost?, sourceName?}] |
| social | `RSS_MAX_ITEM_AGE_HOURS` | 72 | — | 新条目新鲜度闸（小时）：pubDate 比阈值老的直接丢（仍计 seen 防回潮）； 没日期/解析不了的放行（误杀比漏放糟）。2026-08-24：Opus 4.6 旧闻标题党被端上桌的教训。 |
| social | `RSS_MONITOR_INTERVAL_MIN` | 30 | 30 |  |
| social | `RSS_USAGE` | 'summarize' | — | 自动发送时使用的 LLM 路由 |
| social | `WEATHER_CITY` | 'Beijing' | Beijing |  |
| social | `WRITER_BEST_OF_N` | 1 | 1 | Best-of-N 写手:生成 N 稿,选择器挑最贴的发。N=1 关闭。写手 token ×N。 默认 1。best-of-N 对 direct 闲聊路由没有降级(orchestrator.ts:281),等于让一个 maxTokens:2 |
| social | `WRITER_SELECTOR_TIMEOUT_MS` | 6000 | — |  |
| timing | `GROUNDING_ASKED_MAX` | 0.35 | 0.35 |  |
| timing | `GROUNDING_PRESENT_MAX` | 0.35 | 0.35 | topic_present 低于此值算"聊天里没提过"，user_asked 低于此值算"用户没在问"；两者都低才拦。 |
| timing | `TIMING_DEBOUNCE_MAX_BUFFER_MS` | 8000 | — |  |
| timing | `TIMING_DEBOUNCE_MS` | 2000 | — | 阶段 1：消息去抖窗口（毫秒）。0 = 关闭去抖。 同一 chat 内，新消息会重置定时器；超过 MAX_BUFFER_MS 强制 flush 防止饥饿。 |
| timing | `TIMING_GATE_USAGE` | 'judge' | reflection | 阶段 3：Timing Gate LLM usage label。默认走 judge usage（小模型）。 |
| timing | `TIMING_STATE_TTL_SEC` | 86400 | — | 阶段 2：ChatRuntime 状态过期时间（秒）。超过则视作 STOP 默认状态。 |
| timing | `TRENCH_BURST_MAX` | 30 | 30 | 默认值不是拍的，是回测出来的（scripts/envelope-backtest.mts，近 3 天 1841 条）： 实测小时窗峰值 107 / p99 64 / p95 37；5 分钟窗峰值 19 / p99 16。 设 150/100 |
| timing | `TRENCH_BURST_MAX_ACTIVE` | 20 | 20 |  |
| timing | `TRENCH_BURST_WINDOW_SEC` | 3600 | 3600 |  |
| timing | `TRENCH_DEBT_ATTENTION_BOOST` | 0.5 | 3.0 |  |
| timing | `TRENCH_ENVELOPE_MODE` | 'off' | enforce | 房间感知注入：把 frame 已算好的"圈子里谁在跟谁说话/我多久没说话/未了话题"渲染进 CodeAct 任务 prompt。真人不是只回上一条的，bot 却永远在回应、从不在参与—— 2026-09-19 真人对比分析定为此为"差一口气 |
| timing | `TYPESAFE_API_KEY` | '' | apikey_218501f56bb4e8e247ee8af454adfae56 |  |
| timing | `TYPESAFE_ENDPOINT` | 'https://api.typesafe.ai/v1/systemone' | https://api.typesafe.ai/v1/systemone | TypeSafe System One 接入。/v1/systemone；key 是 secret（.env，勿提交）。 |
| timing | `TYPESAFE_MODEL` | 'jev-latest' | jev-latest |  |
| turn | `ANTI_REPEAT_THRESHOLD` | 0.85 | — |  |
| turn | `META_HEART_BYPASS_CHAT_IDS` |  | — | Nyat Trench Phase 1 旁路的**灰度群列表**。空 = 不旁路任何群（默认）。 为什么需要灰度：翻旗的预期效果是把最忙群的发送率从 22% 抬到 86%（投影 3.9x）， 全量翻等于同时改所有群的行为，出了问题也分不清是 |
| turn | `MTM_CHUNK` | 150 | — | 每轮压缩的最老消息条数 |
| turn | `MTM_INPUT_MAX_CHARS` | 16000 | — | 压缩输入字符上限(防超长撑爆 summarize 模型) |
| turn | `MTM_MAX_SUMMARIES` | 10 | — | 摘要 FIFO 上限(超出丢最老的) |
| turn | `PLANNER_MAX_STEPS` | 4 | — | 循环步数上限（MaiBot MAX_INTERNAL_ROUNDS=10,工具场景 4 够用）。 |
| turn | `TURN_ACTOR_CHAT_IDS` |  | — | 灰度群列表（逗号分隔 chatId）。空 = TURN_ACTOR_ENABLED 时对所有 chat 生效。 |
| turn | `TURN_EXEC_LOCK_TTL_MS` | 120_000 | — |  |
| turn | `TURN_INTERRUPT_MAX_CONSECUTIVE` | 2 | 2 | 连续打断上限（MaiBot planner_interrupt_max_consecutive_count，默认 0=不打断； 我们默认 2 —— 高速群里第二条新消息也应能掐死陈旧生成,review #6）。 |
| turn | `TURN_INTERRUPT_QUIET_MS` | 1000 | — | 打断后静默期（毫秒），等这波消息发完再重规划（MaiBot 硬编码 1s）。 |
| turn | `TURN_MAX_INTERNAL_ROUNDS` | 4 | — | 回合内内部轮次预算（reply + 自我接话 + 余量；MaiBot 是 10，保守起步）。 |
| turn | `TURN_MULTI_ANCHOR_MAX` | 3 | — | 每回合最多回几个人(多锚点预算上限,direct 也算在内)。注意:多锚点会让 单回合最多跑 N 次心流调用 + 发 N 条回复(L7 成本/速率),靠此值约束。 |
| turn | `TURN_SELF_FOLLOWUP_MAX` | 2 | — |  |

## ✅ 已退役（2026-09-21）

这些旗标曾出现在上面的死旗标表里，已经删掉——删的时候在段文件原位留了注释说明为什么，避免下一个人再把它们加回来。

| flag | 去向 |
|---|---|
| `PROACTIVE_PRESSURE_ENABLED` | 删（对应的独立 scan cron 已被 unified-tick 取代） |
| `SCHEDULE_LLM_WAKE` | 删（机制从未落地） |
| `AGENT_PROGRESS_PING_ENABLED` | 删（"确定性进度 ping"从未实现） |
| `REPLY_MODE_ENABLED` | 删（"回复形态与安全分段"整个特性没接也没实现） |
| `REPLY_ACK_THEN_EXPAND_ENABLED` | 同上 |
| `REPLY_MICRO_REACTION_MAX_CHARS` | 同上 |
| `REPLY_ACK_MAX_CHARS` | 同上 |
| `REPLY_MAX_EXPANSION_SEGMENTS` | 同上 |
| `TASK_PROGRESS_CODEACT_ENABLED` | 删（task-progress.ts 只读 TASK_PROGRESS_ENABLED） |
| `TASK_PROGRESS_RESEARCH_ENABLED` | 同上 |
| `GOAL_LONG_TERM_ENABLED` | **保留并真接上**：goals.ts 现在读它，关时 long_term 目标按 7 天窗口 stale |
| `CORE_BLACKBOARD_ENABLED` | **保留并真接上**：blackboard/store.ts 四个入口都读它 |
| `GROUNDING_PRESENT_MAX` / `GROUNDING_ASKED_MAX` | **保留并真接上**：grounding-check.ts 原来写死 0.35 |
| `EXPERIENCE_VERIFY_MIN_SUCCESS` | **保留并真接上**：experience-verify.ts 原来用硬编码默认 2 |
| `TASK_MAX_ROUNDS` | **保留并真接上**：task-store.ts 原来写死 6 |

### 2026-09-21 第二批退役（14 个，全仓核过无读者）

| flag | 去向 |
|---|---|
| `DREAMING_USAGE` | 删（dreaming 实际 usage 在 cron 里另取） |
| `CODEACT_MAX_TURNS` | 删（每段轮数上限是 executor.ts 写死的 30，不是这个 8） |
| `TASK_PROGRESS_START_DELAY_MS` | 删（task-progress.ts 只读 KEEPALIVE/MIN_INTERVAL） |
| `JUDGE_PROACTIVE_RATE` | 删（随机主动插话机制整个已删；ENABLED 仍在，但只门控上下文预计算） |
| `JUDGE_PROACTIVE_MIN_INTERVAL_SEC` | 同上 |
| `JUDGE_PROACTIVE_MIN_RECENT_MSGS` | 同上 |
| `SEMANTIC_DUP_THRESHOLD` | 删（semantic-dup.ts 阈值写死 0.7） |
| `STREAMING_MIN_INTERVAL` | 删（流式节流归 TASK_PROGRESS_* 管） |
| `STREAMING_MIN_CHARS` | 删（同上） |
| `TTS_VOICE_PROBABILITY` | 删（TTS 概率在发送路径另有一处） |
| `TTS_MAX_CHARS` | 删（同上） |
| `TURN_UNIFIED_DECISION_ENABLED` | 删（注释说"防 .env 报错"，但 zod 对未知键是剥离不是报错） |
| `VERIFY_DEFAULT_TIMEOUT` | 删（入群验证超时来自 per-chat 的 group_verify_settings） |
| `VERIFY_MAX_ATTEMPTS` | 删（同上） |

### 保留但 grep 不到读者的 2 个

`TS_WEBHOOK_URL` / `PHP_WEBHOOK_URL` —— **不是死键**：`scripts/cutover.sh` 用 shell 读它们。census 只 grep .ts/.mts/.js，所以它们出现在"没人读"表里。删它们会弄坏 cutover 脚本。


还没处理的（本轮不动，原因见下）：`CORE_BLACKBOARD_ENABLED` 是唯一真的没人读的 CORE_* 旗标——blackboard 是 storage 层，被 agent/cognitive-workspace、agency-intent-adapter、core/promote、core/permission/gate 四个模块当存储用了，给它加闸门要同时管住读和写，接错会把在跑的东西关掉，所以留着单独一轮。（另两个 CORE_BELIEF_VIEW_ENABLED / CORE_PERMISSION_GATE_ENABLED 是**接好的**，见上面「假开关」一节的更正。）

`CODEACT_MAX_TURNS` / `TASK_MAX_ROUNDS` / `VERIFY_*` / `TTS_*` / `STREAMING_*` / `SEMANTIC_DUP_THRESHOLD` / `GROUNDING_*` / `JUDGE_PROACTIVE_*` / `EXPERIENCE_VERIFY_MIN_SUCCESS` / `DREAMING_USAGE` 是参数型键，grep 不到读取点但可能被脚本或别处按名取用，删前要逐个确认。


## src/ 里没人读的键（2 个）

| key | 段 | .env | 说明 |
|---|---|---|---|
| `PHP_WEBHOOK_URL` | life | — |  |
| `TS_WEBHOOK_URL` | life | https://hunhebi.sharon.wiki | Cutover (optional — only used by scripts/cutover.sh) |
