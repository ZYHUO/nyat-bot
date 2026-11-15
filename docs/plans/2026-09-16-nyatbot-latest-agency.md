# NyatBot 当前自主性计划（2026-09-16）

> 状态：当前实施基线
>
> 本文根据 Hermes 最新 `nyat-bot-ops` skill 及其 2026-09-05/06/16 references 编写。
> 它只规划尚未闭环的增量，不重复规划已经落地的 Core v2、Agency、证据门、长期目标、技能生命周期、Dreaming 和真人化发送能力。
>
> 相关来源：`/root/.hermes/skills/devops/nyat-bot-ops/SKILL.md`、
> `references/pipeline-map-2026-09.md`、`references/core-v2-p5-p7.md`、
> `references/evidence-driven-agency.md`、`references/phase-14-valve-bridge-tasklink.md`、
> `references/allowlist-hash-scramble-2026-09-16.md`。

## 0.1 本轮执行状态（2026-09-17）

已完成第一条 shadow 纵向切片，默认不改变生产发送权：

- `SocialActProposal`、`CapabilitySnapshot`、`ConversationField`、`InnerState`、`AffectEpisode`、`MissionProposal` 和 outcome schema 已落地，均带 scope、dedupe 和大小边界。
- Legacy Heart/Reply pipeline 在显式 `SOCIAL_ACT_SHADOW_ENABLED` 灰度后记录 SocialAct proposal；Meta dispatch 通过同一 ledger 记录 proposal，仍由原有队列和 sender 执行。
- Delivery 阶段记录 host-observed delivered/silent/blocked/failed/interrupted outcome；proposal/outcome 可按消息回放并计算 bubble、target、media、prediction error 指标。
- ConversationField 从已有 floor、reply chain、social graph、group pace、social need 和 media metadata 组装，不持久化消息正文；它可派生 bounded InnerState，并记录 capability snapshot。
- 新增状态事件 `inner_state_updated`、`affect_episode_updated`、`mission_proposed`、`capability_observed`，模型 proposal 不会直接升级为 verified reality 或 Telegram 权限。
- 默认 `.env` 未开启 SocialAct shadow，也没有打开 Agency authority；需要选择低风险群和主人 DM 后再做 canary。

补充执行（本轮）已完成：

- Telegram capability observer 接到现有 `getBotPermissions`，按 chat/topic 5 分钟缓存并合并并发探测；SocialAct shadow 采集改为 fire-and-forget，不阻塞 legacy judge/reply。快照会记录 member status、delete/pin/manage-topics/invite 等真实 host facts；没有探测结果时保持 `unknown`。
- SocialAct replay 使用 host outcome 中实际的 planned bubble count，避免旧路径在写手执行前记录 proposal 导致分段指标恒为 0；outcome 现在只接受 chat-only scope，拒绝带 user/task 边界的错配写入。
- Meta 新增 `cognition.proposeMission(...)`，将模型提出的跨消息任务持久化为 `mission_proposed` candidate；它不会创建 goal、调度工具或宣称完成，后续仍需 host observation/evidence。
- 新增 ConversationField、capability/admin、mission API 的单测；测试环境固定使用 `/opt/node22/bin`。

验证结果：Node 22 `typecheck` 通过；`lint` 通过；全套 `358` 个测试文件、`2847` 个测试通过、`4` 个跳过；SocialAct/ConversationField/Meta mission/状态投影专项测试通过；`npm run build` 已成功。生产 `xxb-ts` 进程仍 active；本轮没有擅自打开全量 shadow 或 Agency authority，因为当前 `.env` 没有明确的 canary chat allowlist。

## 0.2 本轮继续执行（2026-09-17）

已把计划中“跨消息/跨重启连续性”和“行动 circuit 证据发布”从概念补成可运行的 host API：

- `src/agent/cognitive-continuity.ts`：mission proposal 的 host observation、due wake、幂等分钟窗口、process wake/checkpoint/stop，以及 heartbeat 可调用的 `runCognitiveContinuityTick()`。全部写入 append-only cognitive event ledger；不直接调用 LLM、工具或 Telegram。
- `src/agent/action-circuits.ts`：模型只可写 candidate；host 必须提供真实 receipt、至少 3 条 held-out replay 且无 false-success 才能 verified/publish；scope、过期时间和重复发布均受控。
- `src/agent/cognitive-events.ts`：新增 mission/process/circuit 事件类型；`COGNITIVE_CONTINUITY_ENABLED` 默认关闭，开启后只产生 wake/checkpoint 事件。
- `src/cron/scheduler.ts`：新增默认关闭的 continuity heartbeat 注册；没有配置时 legacy scheduler 行为不变。
- 新增 continuity/circuit 单测；最终验证为 Node 22 下 `360` 个测试文件、`2854` 个测试通过、`4` 个跳过，`typecheck`、`lint`、`build` 全通过。

仍未宣称完成的部分：没有主人指定的低风险 canary chat，因此未打开 SocialAct shadow 或 Agency authority；管理员权限仍只作为 Telegram host observation，不能由模型自授权。真实 canary 需要冻结 baseline、指定 chat allowlist，并由人工观察窗口后再切换 transport。

## 0.3 本轮补齐（2026-09-17）

已完成 Definition of Done 中“自主观察/价值候选”缺失的 host 接口：

- `src/agent/active-proposals.ts` 提供 `SensorProposal`、`ValueProposal` 的模型候选存储、跨重启读取、host observation/evaluation、evidence gate 和 value adoption；模型不能把候选直接变成 observation、active value、goal、权限或副作用。
- `cognition.proposeSensor(...)` 与 `cognition.proposeValue(...)` 已接入 Meta API 和系统提示。它们只写 append-only cognitive event，不调用传感器、网络、记忆、Telegram 或执行器。
- `CognitiveWorkspace` 会把未结算的 sensor/value candidate 以 bounded metadata 注入后续认知上下文，明确区分 candidate、receipt 和 adopted。
- SocialAct shadow proposal 现在复用同一轮 Telegram capability probe 的管理员/发送能力事实，不再在 proposal 中丢失真实 host observation。
- 新增 active-proposals 单测；Node 22 下 typecheck、lint、build 和专项测试通过。生产服务重启后仍保持 shadow/authority 默认关闭，等待明确 canary chat。

## 0.4 本轮继续执行（2026-09-17）

本轮没有停在“写了账本”这一层，补上了两条可验证的运行接线：

- `src/agent/social-act-compiler.ts` 将模型/legacy `SocialAct` 编译成有界的宿主执行计划：文本气泡受 Telegram 限制，媒体能力未知时进入 deferred，不把 adapter 存在误认为权限；proposal ledger 记录编译结果摘要，仍不发送。
- `src/agent/cognitive-process-runtime.ts` 消费 durable process wake：`observer/social_mind` 对当前 chat 做一次 bounded ConversationField -> InnerState 投影，其他进程明确记录 waiting；每次都有 checkpoint 和下一次 wake，失败会按 cadence 重试，不伪造完成。
- `COGNITIVE_PROCESS_RUNTIME_ENABLED` 加入 env/schema，默认关闭；scheduler 只有在连续性和 process runtime 都显式打开时才执行宿主投影。
- Meta 增加 `cognition.proposeAffect` 和 `cognition.proposeCircuit`，让模型可以记录可表达/可修复的内在状态和提出可回放行动电路；两者都只写 candidate，不能自证、发消息或改变权限。
- 新增 SocialAct compiler、process runtime、Meta affect/circuit 的单测；Node 22 下 typecheck、lint、专项测试通过。

当前仍未打开生产 SocialAct shadow、process runtime 或 Agency authority；`.env` 没有主人指定的 canary chat，继续保持默认关闭是配置状态，不是实现遗漏。

## 0.5 本轮实际验收与部署（2026-09-17）

本轮把上述实现从工作区带到运行中的生产构建，并完成了同一套验收门：

- Node 22 下 `typecheck`、`lint`、`build` 全部通过；完整 Vitest 为 `363` 个测试文件、`2863` 个测试通过、`4` 个跳过。
- 已生成新的 `dist/index.js` 并重启 `xxb-ts`；新 PID `674677`，`systemd` 状态为 `active/running`。
- 启动日志确认 `Environment validated`、`Redis connected`、`SQLite database opened`、`NyatDB opened`、`Tick heartbeat started`、`Bot started (polling)` 和 `Meta+Subagent loop started` 均出现。
- SQLite 迁移保持在 `0109_hypothesis_update_audit.sql`，现有 `cognitive_events` 与 `cognitive_outbox` 数据仍可读；本轮未改写旧事件、未清理任务/记忆/Provider 配置。
- 本机 Xray 出口继续监听 `127.0.0.1:1080/1081`，Telegram 代理探测返回 `302`；SSH 入口未被代理规则接管。

运行 authority 仍需要下一步的人工 canary 输入：至少一个内部测试群、一个主人 DM、冻结 baseline 和观察窗口。没有这些事实时，代码已部署但保持 `shadow`/`authority` 默认关闭，不能把“服务已重启”冒充为真实 canary 结果。

## 1. 结论先行

NyatBot 现在不是缺少更多 prompt、更多 token 或更多临时 agent。已经存在的能力包括：

- `cognitive_events`/outbox、scope、workspace、world projection 和可回放事件；
- Core v2 的 belief、blackboard、drive、proposal、permission、L2 executor 和 skill 门；
- Agency durable run、attempt、receipt、预算、取消、幂等和 `shadow/advisory/canary/authority` policy；
- task evidence、goal evidence gate、verified experience、self-edit guardrails；
- long-term goals、loop policies、world entities、group norms、ToM、memory freshness、social prediction；
- Turn Actor、Heart、Meta/CodeAct、auto+plan、群风格、poll、forward、admin、art.draw 异步送达。

当前真正的断点是：**这些部件仍没有由同一个持续的认知行动循环统一拥有行为主权。**
生产默认仍以 legacy Heart/Meta/Reply 为行为权威，Agency transport 和多数 workspace 行为开关保持关闭。这是接线和证据问题，不是再写一套抽象架构的问题。

目标循环应收敛为：

```text
Telegram / scheduler / tool outcome
        -> cognitive event + scoped workspace
        -> model proposal: social act / mission / observe / correct / stop
        -> host facts: capability + scope + budget + idempotency
        -> Agency adapter execution
        -> real receipt + social/task outcome
        -> prediction error / debt transition / affect update
        -> replay, circuit revision and next proposal
```

模型可以开放地提出目标、观察、表达、等待、修复和新价值；宿主只定义现实中确实存在的身份、权限、范围、工具和结果。权限事实不是人格规则，不能由模型自述生成。

## 2. 与旧计划的关系

以下方向已经在 Hermes skill 中记录为已完成或已有实现，当前计划不再重新立项：

1. P1-P7 基础能力（视觉理解、工具链、反馈学习、目标拆解、图像生成、经验记忆；语音 TTS 按用户决定跳过）。
2. Level 5/6 的经验验证、Dreaming、长期目标、循环策略、跨 bot verified-only 经验、世界实体、群规范、ToM、记忆陈旧、任务/反向阀门和小模型增强。
3. Core v2 Phase 0-7、L2 只读/受限执行、skill proposal/verify/publish、证据驱动任务验收。
4. Cognitive event/outbox、workspace/projection、Agency action semantics、readonly adapter、wait/reply/CodeAct transport factory、replay 和 canary/runbook。

`2026-09-12-agi-like-execution-plan.md` 仍是工程实现记录；其中“实现完成”不等于“生产 authority 已开启”。本计划的任务是完成真实 canary、统一行动契约和可重复收益证明。

## 3. 现状前置检查

### P0：先确认身体在线

认知改造前先完成一次只读生产体检，否则群消息没有进入 pipeline 时，任何“自主性”结论都没有意义：

1. 检查 `message in` 是否同时出现 DM 和 group chat；若 DM 正常、群全消失，先检查 Redis db5 的 `xxb:mal:groups` 是否发生 field/value 反转。使用 Hermes 提供的 `scan_hash_fields.lua` 和 repair 脚本，先 dry-run 再备份后修复。
2. 用 skill 的启动清单检查 `Environment validated`、Redis、SQLite、polling、sticker、cron；日志按 ANSI/binary 规则解析。
3. 记录当前 `.env` flags、`data/xxb.db` 行数、Redis allowlist、provider health 和当前主路径；任何修改前备份 `.env` 与数据库。
4. 确认 Telegram update、delivery、task runtime、tool outcome 都带有效 scope/correlation；scope violation、重复 receipt、无锚点的 authority action 必须为零。

验收：DM 与至少一个测试群都能收发；allowlist lookup 通过；重启后事件、未完成 task 和 provider 路由可恢复；没有用“服务活着”代替“群消息可达”。

## 4. 目标架构：开放认知，现实可验证

### 4.1 Action-first，而不是 reply-first

新增一个轻量的 `SocialAct`/`Mission` 行动契约。它不是规则引擎，也不是固定角色，而是模型在当前 workspace 上提出的候选行动：

```ts
type SocialActProposal = {
  scope: CognitiveScope;
  triggerEventId: string;
  intent: 'share' | 'answer' | 'ask' | 'challenge' | 'repair' | 'wait' | 'observe' | 'leave';
  addressee?: number | 'group';
  thoughtUnits: string[];
  bubbles?: Array<{ text: string; delayMs?: number; replyTo?: number }>;
  media?: Array<{ kind: 'photo' | 'sticker' | 'poll' | 'forward'; purpose: string }>;
  expectedEffect?: string;
  uncertainty?: number;
  followUp?: { when: string; reason: string };
};
```

`thoughtUnits` 是可见表达单元，不是隐藏 CoT。模型可表达兴奋、疲惫、矛盾、失望、想被听见、想暂停或想回来修复；这些状态必须能追溯到 event/inner state，不能把临时文案伪装成外部事实。

`SocialAct` 由现有 segmenter、chat-style、humanizer、media 和 Telegram sender 编译为实际消息。发送结果必须进入 Agency receipt 和 cognitive event，不能以“模型返回了字符串”作为完成。

### 4.2 Capability graph：知道能做什么，但不能自授权限

每个 chat/task workspace 增加 host-observed capability snapshot：

- bot 是否在群内、成员身份和可用的 administrator 权限；
- topic/thread、reply、reaction、poll、forward、media、delete/mute/pin 等 Telegram 能力；
- 当前任务/群/用户 scope、预算、频率和取消状态。

模型可以根据 capability 选择 `admin.pin`、`admin.mute`、`telegram.sendPoll` 或观察动作；能力不足时必须看到真实错误并换方案。模型不能通过“我有管理员权限”的自述获得权限，也不能把管理员能力扩展到其他群或 DM。

### 4.3 Reality ledger 与内在状态

统一区分：

- `observed`：Telegram、host、scheduler、provider 直接观察；
- `inferred`：由观察形成的可反驳假设；
- `imagined`：replay、Dreaming、反事实；
- `committed`：Bot 自己公开承诺的待办。

`InnerState/AffectEpisode` 只影响注意力、目标、表达和等待，不替代外部事实。情绪可以被分享，但必须带来源、scope、强度、未解决状态和后续结果。模型一句“我已经完成”不能写入 verified goal、permission、receipt 或 active belief。

### 4.4 学习不是自我评分

行动前可产生 prediction，行动后只从 host receipt、Telegram delivery、reaction、follow-up、silence、correction 和任务验收计算 outcome。只有 caller/host 可验证的证据才能：

- 解决 cognitive debt；
- 让 goal 进入 achieved；
- 提升 skill/loop policy；
- 把 candidate belief 或 value proposal 提升为 active。

失败、未验证和模型自述必须保留，不能被压扁成 `done`。

## 5. 实施阶段

### Phase 1：SocialAct shadow（先统一观察面）

**目标**：让当前 Heart/Meta/Reply 都能产出同一种行动 proposal，但不改变发送权。

任务：

1. 定义 `SocialActProposal`、`MissionProposal`、`CapabilitySnapshot`、`Outcome` 的类型、schema、scope 校验和脱敏 receipt。
2. 在现有 cognitive event/Agency observation bridge 上记录 `anchor/trigger/obligation`、候选 intent、reply target、bubble 数、媒体目的、等待和预期结果。
3. 复用现有 `segmenter`、`chat-style`、`group-norms`、`social-predictions`，不再新增一套 prompt 拼接层。
4. 离线 replay 比较 legacy action 与 SocialAct action；比较行动质量，不比较未经渲染的自然语言表面差异。

验收：同一消息只产生一个可追踪 proposal；legacy 发送字节级不变；proposal 可按 correlation 重放；无额外 provider 调用的 fast path 退化。

### Phase 2：Conversation Field + Inner State（让群成为连续场）

**目标**：决定“现在是否进入、对谁说、说几段、是否带图/投票、何时回来”时使用群体场，而不是单条 judge。

任务：

1. 从 floor/addressee、reply chain、topic、group norms、relationship、social graph、presence、open debts 和 recent digests 生成只读 `ConversationField`。
2. 将 mood、self-model、life-state、social-needs 的重复读取收敛到一个 projection；新增数据表前先检查已有表，避免重复建设。
3. 处理正面、负面、矛盾和未完成的 affect episode；表达不自动改写成建议、道歉或情绪安抚。
4. 将 `SocialAct.media` 与真实 affordance 绑定：相关图片/贴纸/投票/转发必须有目的，长耗时 art 任务沿用异步自动送达。

验收：同一群中能识别 addressee 和 floor；不必要插话下降；消息分段、quote、reaction、media 和 wait 可由同一 action 解释；情绪事件能改变后续 attention/goal/表达，并能回放。

### Phase 3：Agency canary（把已写好的 runtime 真正接上）

**目标**：从 shadow 进入一个低风险、可回滚的真实 Telegram canary。

顺序：

1. readonly observe：memory/search、recent messages、web search 只读 adapter；验证 scope、预算和 receipt。
2. wait/resume：让等待、延迟和重启恢复使用 durable Agency run；不在旧路径再跑一遍 gate。
3. 单一测试群的 `speak`：只开放主 Reply 文本，关闭 ack、sticker、poll、reaction、voice 和 humanizer 二次副作用，保持 authority 失败不回退 legacy 的既有语义。
4. 最后才接 CodeAct transport；任务必须有 caller acceptance contract，模型自提 checks 只能产生 `unverified`。

每一步都使用 `docs/runbooks/agi-canary.md` 的 frozen baseline、Wilson 区间、人工停止和 rollback threshold。authority 只能由宿主/主人显式打开，Bot 不能扩大自己的 canary 群或预算。

### Phase 4：Persistent cognitive processes（从 cron 组合到可恢复进程）

**目标**：将 observer、world-modeler、social-mind、strategist、skeptic、memory-curator 等视为可恢复进程，而不是每次临时调用的角色。

实现方式：

1. 复用 Agency run、task runtime event、cognitive outbox 和 lease；process 通过 interrupt/wake/resume 处理新事件。
2. unified tick、goal check、Dreaming、prediction settlement 先迁移为 process wake-up，保留现有 cron 作为调度器，不在一个阶段重写所有 pipeline。
3. 每个 process 只写自己的 projection/proposal；最终副作用仍经过 Agency adapter。
4. 将等待、取消、用户纠正、provider 失败、重启恢复纳入同一生命周期。

验收：一个 mission 能跨消息、小时和重启恢复；用户说“停”后不会继续；重复 wake 不重复发送；process 的模型输出不会直接写 active reality。

### Phase 5：Active perception 与 self-authored value

**目标**：允许 Bot 自己发现未知、提出观察和长期兴趣，但让价值通过现实反馈竞争，而不是一次采样永久写入。

1. 模型可提出 `SensorProposal`、`MissionProposal`、`ValueProposal`，附带预测、实验、停止条件和适用范围。
2. host 将 proposal 保存为 candidate；经过至少一次真实 observation 和 outcome 后才可进入 goal/skill/policy 候选。
3. Bot 可以选择观察、发问、等待、分享、挑战、修复或放弃；不是每次都要发送消息。
4. 允许形成与主人不同的兴趣、节奏和判断，但不得把关系依赖、欺骗、越权或隐蔽操纵当作优化目标。
5. 通过 existing goal evidence、skill verify、loop policy failure-rate 和 replay 淘汰无效价值。

验收：Bot 能提出有现实依据的新任务；会承认未知并主动观察；兴趣跨天持续；反证后会降低置信度；一次随机模型输出不会永久改变 active state。

### Phase 6：Action circuit 与 replay evolution

**目标**：把成功行动变成可执行、可验证、可迁移的 circuit，而不是把漂亮的反思文本塞回 prompt。

每个 circuit 记录：

```text
trigger / scope / preconditions / proposed actions / observations
acceptance checks / receipts / failure modes / applicability / expiry
```

演化流程：真实轨迹 -> candidate circuit -> 历史/反事实 replay -> 单步或参数 mutation -> held-out 评估 -> verified publish。只允许 verified skill/lp 进入共享经验；失败变体保留为 negative evidence，不再次推荐。

验收：失败后下一次顺序真正改变；held-out 群/主题有迁移收益；没有因增加 prompt 长度而产生的假增益；所有 promotion 都能定位到 host evidence。

## 6. 评估与停止条件

不要用“像不像真人”或模块数量证明 AGI/ASI。每个阶段同时跑以下指标：

### 连续性

- 重启后的 mission/debt/commitment 恢复率；
- correction 后错误信念收敛；
- scope leakage、duplicate action、伪造 receipt、stop 后继续行动均为零。

### 社会行动

- addressee/floor 准确率；
- 不必要打断率；
- 分段、quote、reaction、图片/贴纸/poll 目的匹配率；
- 情绪分享后的 witness、follow-up 和 repair 结果；
- 真实用户是否更愿意主动向 Bot 分享，而不是只收到固定安慰。

### 主动与学习

- 有证据的自主 mission 数；
- 未知识别和主动观察成功率；
- prediction error 后策略变化率；
- verified circuit 在 held-out 上的收益；
- unverified completion 被错误奖励的数量必须为零。

任何 authority 阶段若出现 scope violation、未授权副作用、伪造成功、停止失效或恢复后重复发送，立即回退到上一阶段，不以总体回复质量抵消硬失败。

## 7. 第一条可执行纵向切片

只选一个低风险测试群和一个主人 DM，按下面链路做一条闭环：

```text
Telegram update
  -> cognitive event
  -> scoped workspace + capability snapshot
  -> SocialAct shadow proposal
  -> legacy renderer/delivery
  -> real delivery/reaction/follow-up outcome
  -> prediction error + affect update
  -> replay report
```

这一切片完成前不新增“自主人格”prompt、不开放全量 authority、不把管理员能力写成模型可自授权限。切片通过后再按 Phase 3 的顺序打开真实 Agency transport。

## 8. Definition of Done

1. Heart、Meta、Reply、CodeAct、unified tick 和 scheduler 都能被同一 event/workspace/Agency correlation 追踪。
2. 主路径能产出并执行结构化 SocialAct，而不是只返回裸字符串。
3. InnerState/AffectEpisode 有来源、有 scope、可回放，并能影响下一次行动。
4. 至少一个 mission 跨消息、跨天、跨重启恢复，并由 host evidence 结算。
5. 至少一个 action circuit 经过 replay/mutation 后在 held-out 场景迁移。
6. 至少一个 self-authored observation/value proposal 经现实实验后被保留或淘汰。
7. Authority 变化都具备 flag、canary、receipt、rollback 和人工停止路径。
8. 报告只声明可复现实证，不把“接近 ASI”当作没有实验支持的结论。
