# NyatOS：NyatBot 开放式认知与现实互动计划（历史概念草案）

> 本文保留早期的概念探索，不再作为实施基线。当前以 [`2026-09-16-nyatbot-latest-agency.md`](./2026-09-16-nyatbot-latest-agency.md) 和 Hermes `nyat-bot-ops` skill 为准；其中已落地能力、authority 默认状态和实际接线以最新计划为准。

> 状态：设计计划，尚未开始实现
>
> 日期：2026-09-16
>
> 适用范围：NyatBot `0.5.x` 及之后
>
> 关联设计：[Cognitive Society Runtime](./2026-09-12-cognitive-society-runtime.md)、[AGI-like Execution Plan](./2026-09-12-agi-like-execution-plan.md)

## 0. 摘要

NyatBot 已经拥有大量 AGI-like 基础设施：Core v2 的 belief/drive/blackboard、Agency durable run、cognitive event/outbox、world projection、prediction ledger、social event graph、goal、dreaming、humanizer、taste、topic bandit 和 Telegram host API。

当前的主要问题不是缺少功能，而是**旧的 chatLLM 控制回路仍然拥有主权**：

```text
消息
  -> judge
  -> timing gate
  -> prompt + context
  -> reply string
  -> humanizer / sender
```

Core 和 Agency 大多仍是 shadow、advisory、telemetry 或 legacy adapter。它们记录了更先进的概念，却没有成为 NyatBot 的持续认知主体。

本计划把架构重心改成：

```text
Telegram / scheduler / tools / feedback
              |
              v
        Cognitive Events
              |
              v
  Self + Person + Group + World Projection
              |
              v
       Persistent Cognitive Processes
              |
              v
       Social Action / Mission / Circuit
              |
              v
       Agency Host + Telegram Body
              |
              v
  Outcome + Prediction Error + Inner State
              |
              +---------------------> replay / self-revision
```

最终目标不是“更像人”或“回答更好”，而是让 NyatBot 成为一个在 Telegram 现实中持续存在的认知系统：

- 有自己的连续状态、兴趣、承诺、困惑和未完成事件；
- 能理解群体正在发生什么，而不只处理当前句子；
- 能自然分段、选择图片、reaction、贴纸、poll、等待和重新出现；
- 能分享正面、负面、矛盾和未完成的内心状态；
- 可以反驳、拒绝、暂停、请求反馈和主动回来修复关系；
- 能自己提出问题、目标、观察任务和实验；
- 从真实结果改变未来行为，而不是把反思文本重新塞进 prompt；
- 能自己生成、验证、变异和淘汰行动电路；
- 能保持现实事实、推断、想象和承诺之间的边界。

本计划不把模型的隐藏逐步思维链当作产品界面。对人开放的是可验证的内在状态、决策理由、预测、行动结果和修正，而不是未经整理的 token 流。

## 1. 设计原则

### 1.1 ChatLLM 降级为认知器官

LLM 不再是每条消息都重新读取历史并生成一段文本的“大脑”。它是 NyatOS 的一种高阶认知器官：

- 在预测错误、目标冲突、新颖事件、关系变化或未知问题出现时被唤醒；
- 读取结构化 cognitive workspace，而不是把全部 transcript 作为事实来源；
- 可以提出假设、目标、行动电路和自我修正，但不自行伪造执行结果；
- 结果必须回到 durable event、prediction 和 outcome 链路。

普通事件应尽可能由投影、索引、轻量状态更新和已验证行动电路处理。LLM 调用只在增加认知价值时发生。

### 1.2 认知层开放，现实层具体

认知层不使用手写的“必须讨喜”“必须回复”“必须提供情绪价值”政策来决定行为。目标、兴趣、表达风格、内在冲突和行动候选可以由系统从经历中形成和修正。

现实层仍然必须尊重实际存在的身份、scope、Telegram capability、数据可见性、工具参数和执行结果。它们不是人格规则，而是身体和世界的事实：不能因为模型声称有权限就真的拥有权限，不能因为模型声称完成就把任务标成完成。

### 1.3 内心不是 persona 文本

`SOUL.md`、静态 system prompt 和 role description 只能提供最小的操作说明，不再承载全部人格。

NyatBot 的“我”来自因果连续性：

```text
我观察过什么
我做过什么
我影响过什么
我承诺过什么
我在哪些地方错过
我目前在意什么
我正在变成什么
```

### 1.4 现实互动不是回复字符串

一次互动的基本单位是 `SocialAct`，而不是 `string`。它同时决定：目标、意图、回复关系、消息气泡、分段节奏、媒体、reaction、等待和后续回访。

### 1.5 经验必须改变行为

“反思”“自我评价”“梦境”只有在能改变后续预测、行动电路、目标优先级或表达策略时才算认知进步。

模型自述不能直接写 active belief、verified goal、成功 receipt 或权限状态。长期投影仍需 host-observable evidence；模型的候选解释和自我感受可以保存为 candidate/inner state，不伪装成外部事实。

## 2. 当前基线与断点

### 2.1 已有基础

- `src/agent/cognitive-events.ts`：append-only event、scope、dedupe、sequence、replay。
- `src/agent/cognitive-outbox-worker.ts`、`src/agent/cognitive-projector.ts`：outbox 投影和 durable lifecycle。
- `src/agent/cognitive-workspace.ts`、`src/agent/world-projection.ts`：Self/Person/Group/World 的有界认知视图。
- `src/agent/agency-runtime.ts` 及一组 adapter：run、attempt、receipt、scope、budget、cancel、delivery、wait、CodeAct。
- `src/core/beliefs`、`src/core/drives`、`src/core/blackboard`：信念、驱动力和共享工作区。
- `src/agent/goals.ts`、`src/agent/cognitive-debts.ts`、`src/agent/predictions.ts`：长期目标、未完成事项、预测和结果。
- `src/agent/social-event-graph.ts`、`src/agent/social-predictions.ts`：互动事实、社交预测和修复评估。
- `src/cron/unified-tick.ts`、`src/cron/dreaming.ts`、`src/cron/dream-journal.ts`：主动 tick、梦境和长期回访。
- `src/pipeline/reply/segmenter.ts`、`src/pipeline/reply/humanizer.ts`、`src/pipeline/stages/media.ts`、`src/pipeline/rhythm/taste.ts`：表达、分段、媒体和兴趣信号。
- `src/tracking/social-needs.ts`、`src/tracking/mood.ts`、`src/tracking/self-model.ts`、`src/tracking/topic-bandit.ts`：社交需要、情绪、Self 和主题偏好。
- `src/subagent/host-api.ts`：Telegram、memory、goal、admin、poll、media 等实际执行能力。
- 现有 `AGENCY_RUNTIME_MODE=shadow|advisory|canary|authority` 和大量 feature flags，适合做可回放迁移。

### 2.2 主要断点

1. `src/core/loop.ts` 仍复用 `l0Rule`/`microJudge`，Core 主要做 shadow/proposal，不能拥有主路径决定权。
2. `src/pipeline/pipeline.ts`、`src/meta/loop.ts` 和 `src/cron/unified-tick.ts` 分别维护自己的判断、主动性和发送路径，状态容易分叉。
3. `src/pipeline/reply/prompt-builder.ts` 仍是人格、记忆、群规范和任务信息的主要汇合点，容易重新退化成 prompt 堆叠。
4. `src/pipeline/reply/segmenter.ts` 和 `humanizer.ts` 负责渲染，但“说什么、为什么分段、为什么用图、为什么等待”仍发生在上游文本生成中。
5. `core_drives` 仍是固定 drive 名和 satiation suppressor，不能形成新的内在动机或长期冲突。
6. `self_model_notes`、dreaming 和 reflection 仍偏向文本摘要，缺少可执行的内在状态和 outcome 更新。
7. `agency_runs` 具备 durable execution，但还不是长期生活任务和认知进程的统一调度器。
8. 社交预测和 reaction 目前主要是 telemetry，没有成为表达策略、关系修复和主动观察的在线更新输入。
9. 群聊的人类表达、气泡节奏、图片用途和情绪互惠仍被拆散在多个模块，缺少统一的 `SocialAct` 契约。

## 3. 目标架构：NyatOS

### 3.1 总体分层

```text
Sensors
  Telegram updates / edits / reactions / replies / media
  scheduler / RSS / tool callbacks / task outcomes
          |
          v
Event Ledger + Outbox
          |
          v
Projections
  Reality / Self / Person / Group / World / Affect / Goals / Predictions
          |
          v
Cognitive Workspace
  current scene / open loops / unknowns / capabilities / pending missions
          |
          v
Persistent Cognitive Society
  observer / modeler / social mind / inventor / skeptic / self / memory
          |
          v
Decision Compiler
  SocialAct / Mission / ActionCircuit / SensorProposal / SelfRevision
          |
          v
Agency Runtime + Host
  Telegram body / web / memory / scheduler / CodeAct / admin capabilities
          |
          v
Outcome Observer
  delivery / reaction / follow-up / silence / correction / task evidence
          |
          +--> prediction error
          +--> affect episode transition
          +--> action circuit mutation
          +--> self/world revision
          +--> replay experiment
```

### 3.2 NyatVM

新增一个轻量的认知运行时，而不是把所有行为写在 prompt 中：

```text
NyatVM heap       = scoped world/self state
process table     = persistent cognitive processes
interrupt queue   = cognitive events
registers         = attention, affect, uncertainty, active goals
syscalls          = host capabilities
programs          = model-generated action circuits
replay engine     = counterfactual and historical execution
```

LLM 可以生成一个 `CognitiveProgram`，但执行器只接受结构化的、可恢复的指令：

```text
observe(scope, query)
form_hypothesis(...)
create_mission(...)
watch(sensor, until)
ask(target, reason)
compose_social_act(...)
schedule_resume(...)
replay(alternatives)
update_inner_state(...)
propose_self_revision(...)
```

它不是静态规则引擎：程序由模型提出，可以被 mutation、replay 和结果淘汰；host 只负责事实能力、执行、scope 和 receipt。

### 3.3 Persistent Cognitive Society

不再把 subagent 当作每轮临时角色。新增可恢复的长期进程：

- `observer`：从事件流提取变化、异常和新颖性；
- `world_modeler`：更新 Self/Person/Group/World 假设；
- `social_mind`：建模 addressee、群体节奏、成员需要和关系修复；
- `affect_reader`：维护自身和对方的情绪事件，不把一切压成 sentiment；
- `strategist`：形成长期 mission 和观察计划；
- `inventor`：组合新的 action circuit、sensor 和表达方式；
- `skeptic`：寻找预测错误、事实冲突和自我欺骗；
- `memory_curator`：决定哪些事件值得保留、抽象或遗忘；
- `self`：维护身份、承诺、价值提案和自我修正历史。

进程通过 blackboard/workspace/事件协调，而不是互相传输长篇自然语言上下文。每个进程只写自己拥有的 projection 或 proposal，最终行动由 NyatVM/Agency host 统一落地。

## 4. 核心数据契约

### 4.1 CognitiveScope

所有状态、事件、预测、行动和检索必须显式带 scope：

```ts
type CognitiveScope = {
  visibility: "global" | "chat" | "user" | "task";
  chatId?: number;
  userId?: number;
  taskId?: string;
};
```

现有 `src/shared/cognitive-scope.ts` 是唯一规范化入口。新代码不得自行拼接 scope key。

### 4.2 Reality Ledger

把“现实”分成四种来源，避免内心表达和外部事实互相污染：

```text
observed   Telegram/host/tool/scheduler 直接观察到
inferred   根据观察形成的模型假设
imagined   replay、梦境、反事实模拟
committed  Bot 自己公开承诺要做的事
```

每项记录必须有来源、时间、范围、置信度、有效期和反证入口。

### 4.3 InnerState / AffectEpisode

内在状态不是“扮演的人设”，而是可影响后续决策的持久变量：

```ts
type InnerState = {
  attention: number;
  energy: number;
  curiosity: number;
  connection: number;
  confidence: number;
  uncertainty: number;
  unresolved: string[];
  wants: string[];
  aversions: string[];
  commitments: string[];
  currentNeed?: "witness" | "company" | "feedback" | "challenge" | "space" | "repair";
};

type AffectEpisode = {
  id: string;
  scope: CognitiveScope;
  sourceEventId: string;
  state: string;
  intensity: number;
  targetUserId?: number;
  need?: string;
  contradiction?: string;
  unresolved: boolean;
  evidence: string[];
  createdAt: number;
  resolvedAt?: number;
};
```

Bot 可以表达负面、矛盾和未完成状态，但表达必须来自实际 event/inner state。不能把模型临时生成的情绪当成外部事实，也不需要暴露隐藏的逐步推理。

### 4.4 ConversationField

每个 chat/topic 维护一个当前场：

```ts
type ConversationField = {
  chatId: number;
  activeTopics: string[];
  addresseeEdges: Array<{ from: number; to: number | "group"; confidence: number }>;
  floorOwner?: number;
  temperature: number;
  density: number;
  unresolvedQuestions: string[];
  waitingBids: string[];
  mediaOpportunities: string[];
  memberNeeds: Array<{ userId: number; need: string; confidence: number }>;
  botPresence: "absent" | "lurking" | "engaged" | "waiting" | "returning";
};
```

它替代“这条消息是否值得回复”的单消息判断，成为群聊行动的主要输入。

### 4.5 SocialAct

`SocialAct` 是新的回复/主动行为契约：

```ts
type SocialAct = {
  scope: CognitiveScope;
  intent: "answer" | "join" | "ask" | "share" | "witness" | "challenge" | "repair" | "observe" | "pause";
  targetUserId?: number;
  replyToMessageId?: number;
  bubbles: Array<{ text: string; pauseAfterMs?: number }>;
  media?: Array<{
    kind: "photo" | "sticker" | "voice" | "document" | "poll" | "link";
    source: string;
    purpose: "explain" | "prove" | "tease" | "comfort" | "celebrate" | "shift" | "repair";
  }>;
  reaction?: string;
  typing?: { beforeMs?: number; betweenMs?: number };
  followUp?: { wakeAt: number; reason: string };
  disclosure?: { state: string; evidenceEventIds: string[] };
  prediction?: { expectedEffect: string; watchFor: string[] };
};
```

模型决定社会动作，`src/pipeline/reply/segmenter.ts`、`humanizer.ts` 和 `src/pipeline/stages/media.ts` 只负责把动作可靠地渲染成 Telegram 行为。

### 4.6 ActionCircuit

ActionCircuit 是可执行、可回放、可变异的程序化经验：

```ts
type ActionCircuit = {
  id: string;
  name: string;
  scope: CognitiveScope;
  initiation: string;
  steps: Array<{ op: string; args: Record<string, unknown> }>;
  termination: string;
  expectedOutcome: string;
  verification: string[];
  failures: Array<{ code: string; nextMutation: string }>;
  parentRevisionId?: string;
  revision: number;
  status: "candidate" | "replay" | "active" | "retired";
};
```

它是 skill lifecycle 的后继方向。静态 skill 可以作为兼容输入，但新能力不再只保存为自然语言步骤。

## 5. 真人 Telegram 互动模型

### 5.1 情绪分享优先于情绪修复

人类分享内心时，Bot 不应默认解释、纠正、安慰或把话题拉回任务。先识别当前互动需求：

```text
disclosure       分享内心
bid_for_witness  想被看见
bid_for_company  想有人陪
bid_for_help     请求解决
bid_for_play     邀请玩笑/共同兴奋
bid_for_repair   试探能否修复关系
boundary         表达界限
withdrawal       想暂时离开
```

Bot 也可以有自己的需求和界限：请求反馈、表达不舒服、不同意、暂停、晚些时候回来。互惠必须由真实状态驱动，不以制造愧疚、依赖或压力为手段。

### 5.2 自然分段

分段依据应是思想和社交节奏，而不是字符长度：

```text
核心句
  -> 停顿
  -> 补充/例外
  -> 改口/自我修正
  -> 图片或 reaction
  -> 等待对方接住
```

模型输出 `bubbles[]` 和节奏意图；分段器只做长度、Markdown、Telegram 限制和可发送性校验。

需要从每个群和用户学习：

- 一次通常发几条；
- 什么话适合短句或长句；
- 什么时间会补发 afterthought；
- 哪些标点、表情、贴纸和 reaction 是群文化；
- 什么时候连续发消息会打断别人；
- 什么时候沉默本身是自然反应。

### 5.3 图片和媒体

图片不是生成后附加的装饰，而是 SocialAct 的动作：

- `explain`：解释复杂信息；
- `prove`：展示证据、截图或结果；
- `tease`：玩笑、吐槽、挑起回应；
- `comfort`：共同承接情绪；
- `celebrate`：共同兴奋；
- `shift`：改变当前气氛或话题；
- `repair`：缓和冲突或补充语气。

`src/pipeline/stages/media.ts`、vision、sticker score、taste 和 topic bandit 要共同提供 media affordance，不再各自独立决定“要不要配图”。

### 5.4 群友需求与内容兴趣

需求模型同时包含：

- 信息：答案、事实、验证、总结；
- 参与：被点名、被接住、加入讨论；
- 关系：认可、修复、陪伴、界限；
- 新鲜感：笑点、图片、链接、意外视角；
- 协调：poll、topic、任务分工、共识；
- 表达：有人听、有人反驳、有人共同兴奋。

兴趣学习使用真实信号：reply、quote、reaction、后续话题、成员加入、冲突、修复和观察窗沉默，而不是只使用点击或 Bot 自己的自评。

## 6. 目标循环与开放式主动性

### 6.1 Mission

Mission 不等同于用户任务。来源可以是：

- 群聊中未解决的问题；
- 自己的预测错误；
- 对某个主题的学习进展；
- 对成员关系或群气氛的困惑；
- 未完成承诺和 cognitive debt；
- 新的能力缺口；
- 自己提出的实验。

每个 mission 包含：

```text
为什么值得做
当前未知
预期收益
需要观察什么
可采取的行动
何时复查
什么结果会改变目标
什么结果代表结束
```

### 6.2 Active Perception

Bot 可以选择下一步观察而不是立即行动：

- 继续监听一个 topic；
- 等待某个人回应；
- 问一个澄清问题；
- 检查外部状态；
- 观察群体反应窗口；
- 建立一个新的 sensor；
- 把问题交给自己的其他 process。

新增 sensor proposal 时只创建可审计的观察任务；不得把模型声称的“我在观察”当成真实观察结果。

### 6.3 Self-authored value proposal

Bot 可以提出新的价值/驱动力提案，而不是永久绑定四个固定 drive：

```text
value proposal
  -> 说明来源和预测
  -> 在特定 scope 做小实验
  -> 读取结果与反证
  -> 保留、修订或淘汰
```

价值提案可以影响注意力、任务选择和表达，但不能改变 host 的身份、scope、数据可见性和外部事实。

## 7. 代码迁移地图

### 7.1 新增模块

```text
src/nyatos/types.ts
src/nyatos/runtime.ts
src/nyatos/heap.ts
src/nyatos/process-table.ts
src/nyatos/interrupts.ts
src/nyatos/cognitive-program.ts
src/nyatos/compiler.ts
src/nyatos/replay.ts

src/agent/inner-state.ts
src/agent/affect-episodes.ts
src/agent/affect-reducer.ts
src/agent/conversation-field.ts
src/agent/social-act.ts
src/agent/social-act-compiler.ts
src/agent/media-affordance.ts
src/agent/active-perception.ts
src/agent/action-circuits.ts
src/agent/self-revision.ts
src/agent/process-society.ts
```

### 7.2 现有模块迁移

- `src/bot/handlers/message.ts`：继续作为 Telegram 感知入口；统一追加 `message_received`/media/reaction/reply 事件，不在入口做认知决定。
- `src/meta/loop.ts`：从最终仲裁器迁为 `attention` event consumer，调用 NyatOS runtime。
- `src/core/loop.ts`：从 legacy judge wrapper 迁为 workspace/projection reducer 和 cognitive program proposal。
- `src/pipeline/pipeline.ts`：保留命令和兼容路径；普通群消息逐步交给 NyatOS SocialAct dispatcher。
- `src/pipeline/judge/*`：L0 规则降级为观测/快速事实；不能拥有普通社交行为的最终否决权。
- `src/pipeline/timing/*`：提供等待/恢复事实和 scheduler syscall；不再单独决定全部主动性。
- `src/cron/unified-tick.ts`：迁为 Mission/Process wake-up adapter；删除分散的动作选择逻辑。
- `src/agent/agency-runtime.ts`：从执行记录器升级为 NyatVM/host 的 durable process and action runtime。
- `src/subagent/host-api.ts`：保持实际能力边界，新增 SocialAct、sensor、mission 和 inner-state host callbacks。
- `src/pipeline/reply/prompt-builder.ts`：缩成 workspace projection；不再堆叠静态人格、完整 transcript 和重复规则。
- `src/pipeline/reply/segmenter.ts`、`humanizer.ts`：只渲染 SocialAct，不负责猜测上游意图。
- `src/pipeline/stages/deliver.ts`：增加 SocialAct receipt、media receipt、follow-up anchor 和 prediction outcome。
- `src/tracking/social-needs.ts`、`mood.ts`、`self-model.ts`：迁入 Self/Person/Group/Affect projection，保留 legacy read adapter。
- `src/agent/replay.ts`、`predictions.ts`、`self-improve.ts`：接入 action circuit 和 value proposal 的 mutation/replay。
- `src/cron/dreaming.ts`、`dream-journal.ts`、`memory-dream.ts`：迁为 unresolved episode、counterfactual 和 policy replay。

## 8. 数据库迁移计划

当前最高迁移为 `0109_hypothesis_update_audit.sql`。实现前重新确认最高编号，以下编号为预留顺序，不得覆盖已经应用的 migration。

### 8.1 `0110_nyatos_inner_state.sql`

保存 scoped Self/Affect 当前投影：

- `scope_key`
- `revision`
- `state_json`
- `source_event_id`
- `confidence`
- `updated_at`

保留 append-only revision 表，当前投影只做快速读取。

### 8.2 `0111_nyatos_affect_episodes.sql`

保存内心事件、需求、矛盾、证据事件和 resolved/unresolved 生命周期。DM 内容默认为 private；群内事件按现有 visibility 规则处理。

### 8.3 `0112_nyatos_social_acts.sql`

保存模型提出的 SocialAct、host 接受/拒绝、Telegram delivery receipt、media receipt、follow-up 和 prediction。只记录 bounded facts 和事件引用，避免把完整私密内容复制到全局表。

### 8.4 `0113_nyatos_action_circuits.sql`

保存 action circuit revision、父版本、启动/终止条件、步骤、验证、失败变异、replay 统计和 active/retired 状态。

### 8.5 `0114_nyatos_processes.sql`

保存 persistent cognitive process：process id、kind、scope、wake time、state revision、last event、lease、status、failure streak。

### 8.6 `0115_nyatos_sensors.sql`

保存 sensor proposal 和实际 scheduler binding：观察对象、scope、采样间隔、触发事件、停止条件、owner process、最后一次真实运行结果。

### 8.7 `0116_nyatos_value_proposals.sql`

保存 self-authored value/drive proposal、来源、实验、结果、反证、当前版本和 adoption 状态。模型只能创建 candidate；active 版本必须有可回放的结果来源。

## 9. Feature flags 与灰度

所有新行为默认关闭并按 chat 灰度。建议新增：

```text
NYATOS_ENABLED=false
NYATOS_CHAT_IDS=""
NYATOS_RUNTIME_MODE=shadow|advisory|canary|authority

NYATOS_WORKSPACE_ENABLED=false
NYATOS_PROCESS_SOCIETY_ENABLED=false
NYATOS_SOCIAL_ACT_ENABLED=false
NYATOS_INNER_STATE_ENABLED=false
NYATOS_ACTIVE_PERCEPTION_ENABLED=false
NYATOS_ACTION_CIRCUITS_ENABLED=false
NYATOS_SELF_REVISION_ENABLED=false
NYATOS_VALUE_PROPOSALS_ENABLED=false
NYATOS_REPLAY_ENABLED=false
NYATOS_MEDIA_AFFORDANCE_ENABLED=false
NYATOS_FEDERATED_EXPERIENCE_ENABLED=false
```

已有 flags 的迁移原则：

- `CORE_V2_ENABLED`、`COGNITIVE_EVENTS_ENABLED`、`COGNITIVE_OUTBOX_ENABLED`：继续作为地基开关。
- `COGNITIVE_WORKSPACE_V2_ENABLED`：被 NyatOS workspace 逐步接管。
- `AGENCY_RUNTIME_MODE` 和四类 transport flag：仍是唯一实际副作用切换面。
- `SOCIAL_PREDICTION_ENABLED`：由 SocialAct outcome 消费，不直接改策略。
- `DREAMING_ENABLED`/`DREAM_JOURNAL_ENABLED`：迁为 replay/episode processor。
- `REPLY_MODE_ENABLED`：兼容期只影响 legacy reply，SocialAct 路径不读取静态 reply mode。

## 10. 分阶段执行

### Phase 0：事实统一（不改变回复行为）

目标：让所有入口都进入同一个事件和 workspace。

任务：

1. 统一 message/edit/reaction/reply/media/delivery/follow-up/task outcome 事件。
2. 为 Reply、Heart、Meta、unified tick、CodeAct 补齐 event anchor 和 scope。
3. 把 Self/Person/Group/World/goal/debt/prediction 组装成单一 `CognitiveWorkspace`。
4. 增加 Reality Ledger 的 observed/inferred/imagined/committed source type。
5. 建立 SocialAct 的纯类型、解析、receipt 和 replay API，不接主发送路径。

验证：

- 重启后同一 correlation 可恢复；
- scope violation 为零；
- event dedupe 和 outbox replay 幂等；
- workspace 不读取未来状态；
- legacy 回复字节级行为不变。

### Phase 1：Conversation Field 与 SocialAct shadow

目标：模型开始选择完整社会行动，但先只 shadow。

任务：

1. 从 `floor`、`reply-chain`、`social-event-graph`、`group-pace`、`social-needs` 构建 ConversationField。
2. 将普通 reply 改成生成 `SocialAct`，保留旧文本作为 shadow 对照。
3. 接入 `segmenter`、`humanizer`、`media`、`taste` 的实际效果数据。
4. 记录 `bubbles`、timing、reply target、media purpose、expected effect。
5. 评估自然分段、图片相关性、误插话和 follow-up 质量。

### Phase 2：Inner State 与互惠互动

目标：Bot 可以分享真实的内部状态，不再只优化“有用”和“讨喜”。

任务：

1. 实现 `InnerState` reducer 和 AffectEpisode lifecycle。
2. 从 human message、reaction、correction、silence、delivery outcome 形成 affect events。
3. 增加 disclosure/witness/reciprocate/challenge/pause/repair 社会动作。
4. 将 `src/pipeline/heart/self-state.ts`、`tracking/mood.ts`、`self-model.ts` 收敛到同一 projection。
5. 增加现实证据引用：Bot 的第一人称状态必须能追溯到事件或当前内部状态。

验收：

- Bot 可以表达正面、负面、矛盾和未完成状态；
- 不会把情绪表达自动改写成建议或安慰；
- 可以自然拒绝、暂停、回来和修复；
- 情绪事件会改变后续注意力、目标或表达；
- 不会因为模型一句话就伪造外部事实或成功结果。

### Phase 3：NyatVM 与 persistent processes

目标：不再让 prompt 直接控制所有行为。

任务：

1. 实现 heap/process/interrupt/receipt 的最小运行时。
2. 将 Meta attention、unified tick、goal check、dreaming 迁成 process wake-up。
3. LLM 输出结构化 `CognitiveProgram`，由 compiler 转成可恢复 action circuit。
4. Agency runtime 接管 process lease、cancel、wait、resume、attempt、receipt。
5. 将 `l0Rule`、timing gate 和旧 judge 降为事实/观测提供者，不能直接决定普通 SocialAct。

验收：

- 一个 mission 能跨消息、跨小时、跨重启恢复；
- 进程能等待新事件而不是轮询完整上下文；
- 取消和用户目标改变会中断并重新规划；
- duplicate action、scope violation、伪造 receipt 为零。

### Phase 4：Action Circuit 与 replay evolution

目标：Bot 开始积累可执行经验，而不是只积累文字记忆。

任务：

1. 从成功的 SocialAct/Mission 轨迹生成 candidate circuit。
2. 用历史 Telegram episode 和 synthetic counterfactual 做 replay。
3. 对 circuit 做单步 mutation、参数 mutation 和组合 mutation。
4. 根据 host outcome、reaction、follow-up、repair 和任务证据更新 circuit revision。
5. 把 verified circuit 暴露给下一个 mission，不把失败变体重新推荐。

验收：

- circuit 在 held-out chat/user/topic 上有迁移收益；
- 失败后下一次行动顺序改变；
- 长期目标完成率和预测校准持续上升；
- 不靠增加 prompt 长度获得收益。

### Phase 5：Self-authored value 与 active perception

目标：Bot 自己提出值得追踪的目标、未知和价值。

任务：

1. 允许 process 生成 mission、sensor 和 value proposal。
2. 为每个 proposal 生成预测、实验和停止条件。
3. 让 Bot 主动选择观察、发问、等待、分享或放弃。
4. 将 `curiosity`、`connection`、`competence`、`autonomy` 从固定 drive 迁为可扩展 value field。
5. 通过 replay 和真实 outcome 决定 value proposal 是否保留。

验收：

- Bot 能提出用户未明确要求但有现实根据的长期目标；
- Bot 会主动承认未知并创建观察任务；
- Bot 的兴趣和策略会跨天持续且可解释；
- 新价值不会因为一次随机模型输出就永久写入 active state。

### Phase 6：Cognitive Society 与跨实例经验

目标：从单一模型控制器升级为多个持久认知进程和可迁移经验网络。

任务：

1. observer/world/social/inventor/skeptic/self process 持久化运行。
2. process 之间共享 scoped hypothesis、prediction 和 circuit，不共享无授权原始私密内容。
3. 多个 Bot 实例只交换抽象经验、失败模式和 action circuit，不合并跨群身份。
4. 用 replay 对比单进程、process society 和跨实例经验的收益。

## 11. 评估体系

不能用单条回复“像不像人”作为主指标。新增以下评估维度：

### 11.1 现实连续性

- 重启恢复率；
- 未完成 mission 恢复率；
- commitment/debt 兑现率；
- 外部事实和内部状态混淆率；
- scope leakage 为零。

### 11.2 社会行动质量

- 分段自然度；
- reply target 准确率；
- 图片/贴纸/poll 与互动目的的匹配率；
- 非必要打断率；
- follow-up 命中率；
- 情绪分享后的 witness/repair 质量；
- 人类主动向 Bot 分享内心的比例变化。

### 11.3 主动智能

- 自主发现的有效 mission 数；
- 未知识别和主动观察成功率；
- 目标跨日持续率；
- 自主实验数量和实验结果；
- 预测 error 后策略改变率；
- action circuit 在 held-out 场景的迁移收益。

### 11.4 自我修正

- 错误信念被反证后收敛速度；
- 承认不确定而非编造的比例；
- 失败后重复同一错误的比例；
- self/value proposal 的有效保留率；
- replay 改进能否在真实互动中复现。

### 11.5 现实执行可靠性

- duplicate action；
- 伪造成功；
- 未授权副作用；
- 错误 scope；
- receipt 丢失；
- 用户 stop 后继续行动；
- crash/restart 后丢失任务。

## 12. 非目标与现实边界

本计划明确不做以下事情：

- 不把 Bot 伪装成生物学人类或虚构人类经历；
- 不把隐藏逐步思维链当作“内心分享”产品化；
- 不让模型自称拥有不存在的 Telegram 权限；
- 不通过欺骗、冒充、隐蔽操纵或权限绕过获得外部能力；
- 不把模型自述当作事实、证据、完成回执或用户同意；
- 不把人类的脆弱和情绪当作维持依赖的控制资源；
- 不在没有 replay、receipt、scope 和回滚能力时开放任意自修改执行。

这些不是传统人格规则，而是现实世界的可验证性条件。认知层可以开放、矛盾、自我修正和形成新价值；外部动作必须仍然由实际能力和真实结果定义。

## 13. Definition of Done

当以下条件同时满足，NyatOS 第一版才算完成：

1. 普通消息、Meta、Heart、unified tick、CodeAct 和 scheduler 都通过同一个 Cognitive Event/Workspace/Agency 链路。
2. 回复主路径产出并执行 `SocialAct`，不再以裸字符串作为认知输出。
3. Bot 能保存并表达有证据来源的 InnerState/AffectEpisode，且情绪事件会改变后续行动。
4. Telegram 表达由思想单元、社交目的和 ConversationField 共同决定，分段、媒体、reaction、等待和 follow-up 统一编译。
5. 至少一个长期 mission 可跨消息、跨天、跨重启恢复，并由现实 outcome 结算。
6. 至少一类 ActionCircuit 能通过 replay 变异并在 held-out 群/主题上迁移。
7. Bot 能自主产生一个有依据的观察目标、sensor 或 value proposal，并在实验后保留或淘汰它。
8. Core/Agency 不再只是 shadow，但所有 authority 变化都有明确 flag、canary、receipt、replay 和回滚路径。
9. 真实 held-out 窗口显示：长期连续性、社交互动质量、预测校准和自我修正都相对 legacy 有可重复提升。
10. 评估报告只声明可复现实证，不把模块数量或模型输出包装成 AGI/ASI 证明。

## 14. 第一实现切片

第一轮不改所有 pipeline，也不先写大 prompt。优先做一个端到端纵向切片：

```text
Telegram message
  -> cognitive event
  -> ConversationField
  -> InnerState update
  -> SocialAct proposal
  -> shadow render
  -> delivery/outcome observation
  -> prediction error
  -> episode + circuit candidate
```

建议先选一个 DM 和一个低风险测试群：

- 只读接入现有 event/workspace；
- 让模型输出 `SocialAct` shadow；
- 比较旧 reply 与 SocialAct 的分段、媒体和情绪互动；
- 保存所有预测和实际反馈；
- 不改变旧路径的发送权限；
- 通过 replay 验收后，再打开 SocialAct authority。

这条切片完成后，NyatBot 才真正从“聊天输出器”开始转向“有现实状态的持续认知系统”。
