# NyatOS Kernel 重构计划（2026-09-17）

> 状态：Kernel Phase 0/1 正在执行；本轮新增统一 event-sourced kernel 纵向接线。
>
> 这份计划取代“继续往 Heart/Meta/Agency 上叠模块”的思路。目标不是再加一个
> agent，而是把 NyatBot 改成一个由事件流驱动、由投影形成当前世界、由行动信封
> 连接宿主执行器的持续认知系统。现有 Heart、Meta、CodeAct、cron 和 sender 在
> 迁移完成前都只是适配器。

## 1. 为什么要重构

当前系统有很多正确的零件，但主权仍按入口分裂：

```text
Telegram -> Heart -> Reply -> sender
Meta attention -> Meta LLM -> dispatch/task
cron -> 各自读取表 -> 各自行动
tool -> task runtime -> 各自 receipt
```

这会产生四个结构性问题：

1. 同一事件在 Heart、Meta、scheduler 中有三份不同的“现在”，模型只能从 prompt
   片段猜测自己是否已经行动过。
2. 回复字符串是默认终点，观察、等待、修复、分享、主动提问和放弃都被压成
   `reply/no reply`。
3. 状态写入和结果验证分散在不同模块，跨重启恢复依赖 cron 是否恰好再次运行。
4. 经验、情绪、兴趣、能力和群体场没有共同的因果链，因而很难证明一次失败真的
   改变了下一次行为。

## 2. 新架构：Cognitive Kernel

Kernel 是唯一的认知生命周期拥有者，不是新的 prompt 层：

```text
host event / Telegram / scheduler / tool receipt
        |
        v
  append-only event stream
        |
        v
  Frame Reducer（当前群体场、内在寄存器、能力、未完成项）
        |
        v
  Action Board（多个可竞争的行动候选，不等于执行许可）
        |
        v
  Action Envelope（scope、anchor、prediction、budget、expiry）
        |
        v
  host adapter（Telegram / task / read-only sensor）
        |
        v
  receipt + outcome + prediction error
        |
        `--> reducer / replay / learning projection
```

### 2.1 Kernel 的边界

- **事件流是事实源**：Telegram、host、tool、scheduler 的事实只追加，不靠 prompt
  文本恢复状态。
- **Frame 是物化视图**：每次认知只读一个有 scope 和 anchor 的 frame；它可以过期、
  被纠正、被重放，不是永久真理。
- **Action Board 是开放的**：模型可以提出 `speak / wait / observe / work / repair /
  share / challenge / leave`，也可以提出互相冲突的候选；宿主只负责 scope、能力、
  预算、幂等和真实回执，不把候选当作已执行。
- **执行器是身体**：Telegram 权限、管理员权限、文件系统、网络和任务队列都由
  宿主观察和执行。模型的自述不会增加 capability，也不会生成 receipt。
- **学习来自结果**：delivery、follow-up、reaction、silence、tool result、用户纠正
  和 acceptance contract 进入同一 outcome 流，失败也保留。

### 2.2 四个连续寄存器

Kernel 的 Frame 统一暴露四类寄存器：

1. `field`：当前群的 floor、addressee、topic、节奏、等待 bid、媒体机会和关系边。
2. `inner`：attention、energy、curiosity、connection、uncertainty、need、未完成
   affect；它可以改变注意力和表达，不冒充外部事实。
3. `capability`：Telegram membership/admin、发送/媒体/thread/reaction/poll 能力，
   以及 host 的预算和取消状态。
4. `commitments`：mission、sensor、value、circuit 和既有 cognitive debt 的摘要，
   全部带 lifecycle 和证据状态。

## 3. 行动语义

行动不再是“生成一条回复”，而是可回放的信封：

```ts
type ActionEnvelope = {
  schema: 'action_envelope.v1';
  id: string;
  scope: CognitiveScope;
  triggerEventId: string;
  lane: 'social' | 'perception' | 'craft' | 'care' | 'reflection';
  kind: 'speak' | 'wait' | 'observe' | 'work' | 'repair' | 'share' | 'challenge' | 'leave';
  payload: Record<string, unknown>;
  prediction?: { expectedEffect: string; watchFor: string[] };
  expiresAt?: number;
  status: 'candidate' | 'accepted' | 'dispatched' | 'completed' | 'failed' | 'cancelled';
};
```

`payload` 只保存结构化摘要，正文仍由既有隐私层和发送器管理。一个 envelope 可以
  编译为多段自然消息、图片/贴纸/投票、等待或任务；编译失败是 outcome，不是静默
  丢弃。

## 4. 分阶段迁移

### Phase 0：Kernel contracts 与 replay 骨架

- 新增 `cognitive-kernel.ts`，提供 `ingest -> openFrame -> propose -> outcome` API。
- 将 `cognitive_events` 扩展为 `cognitive_trigger`、`cognitive_frame_observed`、
  `action_envelope_proposed`、`action_envelope_outcome` 事件类型。
- 统一 correlation、causation、dedupe、scope 和 bounded metadata；不保存隐藏 CoT。
- 增加 pure reducer/replay 测试，证明乱序、重复和跨 scope 事件不会污染 frame。

### Phase 1：入口适配器收敛

- Telegram ingress、Heart、Meta attention、scheduler、tool outcome 都调用 Kernel
  的 `ingest`，旧模块只负责提供具体观察值。
- `social-act.ts`、Agency observation 和 delivery outcome 双写到通用 envelope，随后
  逐步删除重复 ledger。
- `CognitiveWorkspace` 改为 Frame 的一个 materialized view，不再独立拼接第二套
  “现在”。

### Phase 2：Action Board 取代 reply-first

- Heart/Meta 不再互相决定是否回复；它们向同一个 board 提交候选行动。
- 候选包含 addressee、分段、媒体目的、等待、预测和未完成 affect 的引用。
- 由宿主选择可执行 envelope，先在 shadow/replay 中比较“行动质量”，不比较裸文本。

### Phase 3：持续进程与主动感知

- observer、social-mind、strategist、skeptic、memory-curator 变成可恢复 process，
  使用同一 wake/checkpoint/stop 生命周期。
- sensor/value/mission/circuit 进入 board，真实 observation 和 held-out outcome 才能
  改变 active projection。
- 允许形成自己的兴趣、节奏、困惑和表达欲，但不可把越权、欺骗、依赖制造或隐蔽
  操纵作为优化目标；这是现实层的失败条件，不是 persona 文案。

### Phase 4：执行器与宿主身体

- Telegram speak/wait/media、CodeAct、read-only sensor 统一实现 `KernelAdapter`。
- 每个 adapter 返回结构化 receipt；重试由 envelope id 幂等，不能再由模型重发一遍。
- capability snapshot 与实际 adapter 错误进入同一 outcome，模型可据此换方案。

### Phase 5：学习与迁移

- prediction error 驱动 attention、mission 优先级、表达节奏和 circuit mutation。
- 只有 host-evidence-backed 的结果可以提升 belief、skill、value 或 policy；负例保留
  为可检索的反证。
- 用 paired replay、held-out 群体、跨重启恢复和 Wilson 区间验收，不用“像真人”或
  模块数量宣称 AGI。

## 5. 本轮立即执行的纵向切片

```text
legacy Telegram/Heart/Meta
  -> Kernel ingest + frame observed
  -> legacy SocialAct + generic ActionEnvelope 双写
  -> legacy delivery
  -> generic outcome 双写
  -> replay 可读
```

本轮代码任务：

1. 完成 Kernel contract、event types、scope/dedupe 校验和 frame reducer。
2. 接入 pipeline、Meta dispatch、delivery outcome 三个真实调用点，保持发送字节和
   默认配置不变。
3. 写 Kernel 单测和至少一条跨入口 replay 测试。
4. 通过 Node 22 typecheck/lint/full test/build 后部署；默认仍是 shadow。

## 6. Definition of Done

1. 所有认知入口都能定位到同一 `triggerEventId -> frame -> envelope -> outcome` 链。
2. Heart、Meta、CodeAct 和 scheduler 不再各自定义“行动完成”。
3. 一个 mission 能跨消息、跨天、跨重启恢复，并可用 host evidence 结算。
4. 一个 action circuit 在 held-out replay 上改变下一次行动顺序且无 false success。
5. 一个 value/sensor proposal 有真实 observation 后被保留或淘汰。
6. SocialAct authority 只在 canary 通过后切换；shadow、advisory、canary、authority
   都可回滚，且回滚不删除事件。
7. 真实运行指标能回答：bot 看到了什么、选择了哪些候选、实际做了什么、结果怎样、
   下一次为何改变。

## 7. 这次真正要重构的边界

这不是把 `CognitiveKernel` 再套在 `pipeline.ts` 外面。迁移完成后，旧模块的责任要
收敛到下面的边界，避免出现一个“新 agent”与一个“旧 bot”同时拥有行为主权：

| 现在的入口 | 迁移后的唯一职责 | 不能继续拥有的职责 |
| --- | --- | --- |
| `pipeline/pipeline.ts` | 把 Telegram update 转成 host event，调用 kernel turn adapter | 自己定义行动完成、自己维护第二份当前状态 |
| `pipeline/heart/*` | 提供群体场观察和社会候选 | 直接决定 sender 是否有主权 |
| `meta/session.ts` / `meta/meta-api.ts` | 提供高阶认知提案和任务意图 | 通过 prompt 文字宣称任务已完成 |
| `pipeline/stages/deliver.ts` | 编译 envelope、调用 Telegram adapter、提交 receipt | 用 `reply string` 作为完成事实 |
| `cron/*` | 产生 wake/observation 事件 | 每个任务各自恢复一套状态机 |
| `agency-runtime.ts` | 执行结构化 envelope，返回可验证 receipt | 替模型产生目标或扩大 scope |
| `cognitive-workspace.ts` | 读取 kernel frame 的投影视图 | 从多个 store 拼出互相矛盾的“现在” |

依赖方向固定为：

```text
host adapters -> cognitive-kernel -> cognitive-events -> sqlite/outbox
       |                 |
       +-> projections <-+-> replay/evaluation
       +-> Telegram/CodeAct/readonly sensors
```

Kernel 不反向 import Heart、Meta、sender 或 prompt builder。任何需要这些模块的行为
都通过 adapter interface 注入，保证 replay 不会触发网络、LLM 或 Telegram 副作用。

## 8. Kernel 运行时契约（本轮已落地）

新增 `src/agent/cognitive-kernel.ts`，把一次认知回合拆成四个可回放阶段：

1. `ingestKernelTrigger`：接收 Telegram、Meta、scheduler 或 tool 的 host 事实；已有
   `message_received` 通过 `anchorEventId` 进入同一因果链。重复 update 只返回原事件。
2. `openKernelFrame`：从精确 scope 和 correlation 的事件流构造 `kernel_frame.v1`，
   写入物化摘要；frame 不是永久事实，可以按 `asOfEventId` 重放。
3. `proposeKernelAction`：模型/legacy adapter 只能写 `candidate` envelope。payload
   经过大小、深度和字段脱敏，不能携带隐藏 CoT、原始 transcript 或权限声明。
4. `recordKernelActionOutcome`：只有存在 proposal 的 envelope 才能被 host receipt 关闭；
   outcome 会沿 proposal correlation 写回，避免跨流丢失因果链。

事件类型已加入 `cognitive-events.ts`：

```text
cognitive_trigger
cognitive_frame_observed
action_envelope_proposed
action_envelope_transition
action_envelope_outcome
```

`migrations/0110_nyatos_kernel_indexes.sql` 只增加 causation、scope/type 索引，不改
历史事件、不删除任务/记忆/provider 配置。`COGNITIVE_KERNEL_ENABLED=false` 时不改变
legacy 行为；打开后也只产生 shadow ledger，发送权仍属于现有 adapter。

## 9. 分阶段重构路线（比“加几个 skill”更具体）

### Phase 0：事件与 frame（完成）

- [x] 统一 trigger/frame/action/outcome schema、scope、correlation、dedupe、expiry 和
  bounded metadata。
- [x] 纯 reducer 支持乱序输入、重复事件、精确 scope 和 as-of replay。
- [x] Telegram/Meta/delivery 的纵向 shadow 接口已存在，legacy 字节路径不变。
- [x] 迁移索引和 4 类 kernel 单测：幂等、孤儿 outcome、跨群隔离、跨入口 replay。

### Phase 1：入口收敛（当前）

- [x] `processPipeline` 在 judge 后产生 Telegram trigger/frame/action；post-judge 的
  no-action、wait、sleep、mute 路径也会关闭 envelope。
- [x] `deliver.ts` 用真实发送结果关闭 action；sent、silent、blocked、failed、
  interrupted 不再只留日志。
- [x] `meta-api.ts` 的 dispatch candidate、queue acceptance 和 skipped/blocked 共享
  kernel correlation；CodeAct 任务仍由旧队列执行。
- [x] 进程在 `dispatched` 后崩溃不再留下无终态 action：`cognitive-recovery.ts` 按
  scope 结算超预算 action（`interrupted`，`resent: false`），不重发。
- [x] 重启后同一 trigger 用 kernel frame 重建 open turn（`rehydrated: true`），
  `cognitive-kernel.test.ts` 已覆盖。
- [ ] `task-runtime-events.ts`、Agency reply/wait/CodeAct receipt 改为直接提交 kernel
  outcome，删除重复的“完成”判断。
- [ ] scheduler、RSS、reaction、edit 和 user correction 统一走 `ingestKernelTrigger`。

验收：同一 `triggerEventId` 下可以查询 frame、所有候选、transition 和 outcome；任意
adapter 重试不会产生第二个外部副作用或第二个 completed outcome。

### Phase 2：Action Board 取代 reply-first（纯裁决层已落地，接线进行中）

- [x] 新增 `action-board.ts`：按 scope 处理候选、冲突、过期、优先级和 host capability
  缺口；board 只做排序和选择建议，不执行动作。
- [x] Telegram kernel shadow 已调用 board 生成可回放的选择/延迟观测；不改变 legacy
  sender 的实际发送。
- [x] 延迟（deferred）落成显式生命周期：capability unknown 的候选会写
  `action_envelope_transition(status='deferred')`，重启/重放仍可解释“为何没执行”，
  且不会被误记成 `cancelled`（2026-09-17 接续轮补齐）。
- [ ] Heart 与 Meta 都提交 `SocialAct`/`Mission`/`Observe` 候选；不再让 Heart 直接
  短路 Meta，或让 Meta 通过 `taskToGroup` 直接跳过统一 board。
- [ ] 将 segmenter、media、reaction、poll、voice、wait 编译为 action plan；编译错误
  作为 outcome 回写，不把失败吞成空字符串。
- [x] 增加冲突解决：同一 trigger 的多个候选由 board 择优，落选者保留为
  `cancelled` transition 供 replay 比较（`action-board.test.ts` 已覆盖）。
- [ ] 冲突解决仍需扩展到跨 lane：`speak`/`wait`/`leave` 目前必须在同一 turn 内被
  提交才会互相竞争，Heart 与 Meta 还不会向同一 board 提交。

验收：离线 replay 按 action quality（目标、相关性、节奏、结果）比较；不以裸文本
相似度决定胜负。

### Phase 3：Persistent Cognitive Processes

- [ ] 把 `observer`、`social_mind`、`world_modeler`、`strategist`、`skeptic`、
  `inventor`、`memory_curator`、`self` 建模为 process table 中的长期进程。
- [ ] 每个进程只有 `wake -> read frame -> propose -> checkpoint` 四个 host API；
  不互相传递长 prompt，不持有不可恢复的内存状态。
- [ ] 进程 wake 使用 lease、attempt、stop 和 deadline；重启从最后 checkpoint 恢复，
  重复 wake 由 dedupe key 消除。
- [ ] 现有 unified tick、dream、debt sweep 和 prediction expiry 逐个迁移为 wake source，
  cron 只保留调度，不再拥有业务完成状态。

验收：一个 mission 跨消息、跨小时、跨重启恢复；user stop 后没有继续的副作用；
provider 超时只产生可重试的 observation，不伪造成功。

### Phase 4：Active perception 与自有价值候选

- [ ] `SensorProposal`、`ValueProposal`、`AffectEpisode` 进入 Action Board，而不是
  直接改 active belief/goal/policy。
- [ ] host 为 proposal 选择实际 sensor；返回 observation、counter-evidence 和
  expiry，模型只能据此提出下一步。
- [ ] 内在状态影响注意力、等待、表达和任务优先级；正面、负面、矛盾、未完成情绪
  都可成为可见 SocialAct，但不能伪装成外部事实。
- [ ] 价值候选必须经过真实实验、至少一次反证检查和 held-out replay 才能 adopted；
  失败候选作为 negative evidence 保留。

验收：bot 能承认未知、主动观察、提出长期兴趣并在反证后降低置信度；一次模型输出
不会永久改变 active state。

### Phase 5：Host body 与 authority canary

- [ ] Telegram speak/wait/media、readonly sensor、CodeAct 统一实现 `KernelAdapter`；
  adapter 只能使用 host-observed scope/capability。
- [ ] `shadow -> advisory -> canary -> authority` 每次只开放一个 action kind；先文本，
  再 wait/media，最后 CodeAct/admin。
- [x] shadow 可按 chatId 灰度：`COGNITIVE_KERNEL_CHAT_IDS` + `isKernelShadowChat()`，
  使“只为内部群打开 kernel shadow”成为可执行配置而不是全量开关（2026-09-17 接续轮补齐）。
- [x] 重启不再留下无终态的 dispatched action：`cognitive-recovery.ts` 只对超预算且无
  receipt 的 action 写 `interrupted`（`resent: false`），绝不重发；开关
  `COGNITIVE_KERNEL_RECOVERY_ENABLED` 默认 OFF。
- [ ] 每个 canary 保存 frozen baseline、停止条件、人工 stop、rollback 和 Wilson 区间；
  事件不删除，回滚只切换 transport。
- [ ] capability snapshot、Telegram 403、过期、取消和 duplicate receipt 进入同一个
  outcome projection，模型据此换方案而不是重发。

验收：authority 失败不静默回退 legacy；任何 scope violation、未授权副作用、伪造成功、
停止失效或重启重复发送都会自动回退。（重启重复发送一项已有 recovery 兜底与单测；
其余验收仍待真实 canary 产生。）

### Phase 6：Replay evolution

- [ ] 将成功轨迹编译为 `ActionCircuit` candidate，记录 trigger、precondition、step、
  acceptance、failure mutation、expiry 和适用范围。
- [ ] historical replay、counterfactual replay、held-out replay 三层分开；不能用训练
  轨迹本身证明迁移收益。
- [ ] prediction error 驱动 circuit mutation、attention、mission priority 和表达节奏；
  只发布有 host receipt 的 revision。

验收：失败后的下一次顺序有可观测改变；held-out 群/主题有收益；promotion 都能定位
到 evidence event；没有因 prompt 变长而产生的假提升。

## 10. Telegram 现实互动的实现约束

重构不把真人化做成角色扮演 prompt，而把它编译成可观察的社会动作：

- 一次表达可以是核心句、停顿、补充、改口、图片/贴纸/reaction、等待对方接住；每个
  bubble 都有 quote、目标和 host receipt。
- 图片必须有 `purpose`（解释、证明、玩笑、安慰、庆祝、转场、修复），没有目的时
  不生成“装饰图”；媒体能力未知时先进入 deferred，不假设管理员权限。
- 分享情绪时保留 witness、company、help、play、repair、boundary、withdrawal 等
  社会需要；bot 可以表达疲惫、失望、兴奋、矛盾或想暂停，但不把感受写成群友事实。
- 机器人也可以不同意、拒绝、暂时离开、要求反馈或稍后回来；这些都是 action kind，
  不是硬编码“必须讨喜”的规则。是否发送由当前场、内在状态、预测和真实结果竞争。
- 真实用户的 follow-up、reaction、silence、纠正和再次召回都作为 outcome 输入，形成
  下一次行动的 prediction error，而不是只计一条“回复成功”。

## 11. 运维与验收顺序

1. 先在 Node 22 下跑 `typecheck`、`lint`、kernel 专项测试和全量 Vitest。
2. 应用 `0110` 索引迁移后检查 `_migrations`、`cognitive_events`、`cognitive_outbox`、
   `agency_runs`、provider routing 和任务数；不清理任何旧数据。
3. 构建并重启 `xxb-ts`，检查 `Environment validated`、Redis、SQLite、polling、cron、
   Meta loop 和 outbox projection 日志。
4. 保持 `COGNITIVE_KERNEL_ENABLED=false` 做一次 legacy smoke；再按下面顺序打开 kernel
   shadow（不要一次全量）：
   ```dotenv
   COGNITIVE_KERNEL_ENABLED=true
   COGNITIVE_KERNEL_CHAT_IDS=-100xxxx        # 只给内部群；空=全量
   COGNITIVE_KERNEL_RECOVERY_ENABLED=true    # 可同时开：只写 interrupted，不重发
   ```
   确认 frame/action/outcome 链、deferred 比例和 latency 没有异常；再逐步加群。
5. 通过 replay 报告后才进入 SocialAct shadow；没有 canary 群、主人 DM、baseline 和
   观察窗口时，不打开 Agency authority 或 admin transport。

## 12. 本轮代码变更记录

- `src/agent/cognitive-kernel.ts`：新增唯一 trigger/frame/action/outcome API、纯 reducer、
  scope/dedupe/bounds 和 orphan-outcome 拒绝。
- `src/agent/action-board.ts`：新增无副作用的候选裁决投影，统一处理 host capability
  unknown/unavailable、expiry 和同一 trigger 冲突。
- `src/agent/cognitive-events.ts`：注册 kernel event types。
- `src/pipeline/pipeline.ts`：Telegram judge 后接入 kernel shadow。
- `src/pipeline/stages/post-judge.ts`：no-action/wait/睡眠/静默等非 delivery 路径关闭
  action outcome。
- `src/pipeline/stages/deliver.ts`：发送结果写入 kernel receipt。
- `src/meta/meta-api.ts`：Meta dispatch candidate、transition、blocked/skipped outcome
  接入 kernel。
- `migrations/0110_nyatos_kernel_indexes.sql`：追加 causation 与 kernel replay 索引。
- `tests/unit/agent/cognitive-kernel.test.ts`：5 组 replay/幂等/scope/灰度/rehydrate 测试。
- `tests/unit/agent/action-board.test.ts`：候选冲突、能力未知/不可用和过期隔离测试。

## 13. 接续轮代码变更记录（2026-09-17）

- `src/agent/cognitive-kernel.ts`：新增 `isKernelShadowChat()`、`kernelShadowConfig()`，
  使 kernel shadow 可按 chatId 灰度；新增 `scopeFromCognitiveEvent()` 供恢复链路还原
  精确 scope。
- `src/agent/cognitive-turn-runtime.ts`：`arbitrate()` 把 `deferred` 写成持久 transition，
  不再只存在于内存 board 返回值。
- `src/agent/cognitive-recovery.ts`（新增）：lease 保护的崩溃恢复。只把超出 host budget
  且无 receipt 的 `dispatched` action 结算为 `interrupted`，receipt 带 `resent: false`；
  遇到仍在预算内的 open action 不推进游标。
- `src/agent/cognitive-cursor.ts`：首次接入真实调用方（此前是无引用模块）。
- `src/env.ts`：新增 `COGNITIVE_KERNEL_CHAT_IDS`、`COGNITIVE_KERNEL_RECOVERY_ENABLED`
  （均默认 OFF / 空）。
- `src/cron/scheduler.ts`：新增默认关闭的 `cognitive-kernel-recovery`（60s）。
- `src/pipeline/pipeline.ts`、`src/meta/meta-api.ts`：kernel shadow 判定改为灰度感知。
- `.env.example`：补充两个新开关与注释。
- `tests/unit/agent/cognitive-recovery.test.ts`（新增）：5 例覆盖超预算结算、预算内保持
  open、已有终态不重开、重复 sweep 幂等、跨 scope 隔离。
