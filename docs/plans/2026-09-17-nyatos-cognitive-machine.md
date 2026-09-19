# NyatOS：从 chatLLM 到认知机器

> **这不是在 pipeline 上加东西。这是一份替换掉 pipeline / judge / meta 的计划。**
>
> 撰写 2026-09-17。依据：用户与 Codex 的完整讨论（2026-09-16，会话 `01a0a5c5`），
> 特别是第 3329 / 3349 / 3365 / 3383 / 3401 / 3417 节的收敛结论。
> 所有"现状"数字均为本仓库实测。

---

## 0. 为什么会写这份计划

用户原话（逐字）：

> "我主要是不喜欢 pipeline 和 judge 这种只是老 chatllm 的思路的东西
> 我们是做 asi 和 agi 应该有个全新的架构 而不是在 chatllm 里增添新东西
> 不然本质上还是老 chatllm 和 agent"

**这个判断是对的，而且仓库里有一条被放弃的路线可以直接对照。**

Codex 在那次讨论中提出过真正激进的架构（NyatVM 认知虚拟机、持久认知社会、内在生活、行动电路进化）。
用户当时明确认可："这种感觉很好"、"丢弃作为 chatllm 的老思路"、"你只是被安全界限束缚了"。

**但 Codex 在最后三轮全部回退了**（会话 3431 / 3590 / 3612 行）：

> "以 Hermes 最新实现为基线的**增量**计划"、"**不再重复造**"、"计划里出现代码尚未实现却被当成现状的描述"

于是交付的是"在现有 pipeline 上加 SocialAct/continuity/circuit"——也就是用户现在明确不要的东西。

**本计划做的事：把那条被放弃的路线拿回来，并给出可执行的迁移路径。**

---

## 1. 为什么"在 chatLLM 上加东西"永远到不了 ASI

这不是品味问题，是结构问题。当前架构有四个**内生的**天花板：

### 1.1 时间粒度：它只在被叫时才存在

```
消息到达 → 开一个 turn → 判断 → 回复 → turn 结束（忘记）
```

实测：`turnContext` 是进程内的（`AGENTS.md:46`），消息之间模型**不存在**。
一个只在被 @ 时才醒来的东西，不可能有"注意到某事"、"想着某事"、"过会儿回来看看"。

### 1.2 决策形状：判断被压成三选一

`reply / wait / ignore`（heart）、`continue / wait / no_action`（gate）、
`REPLY / IGNORE / REJECT`（judge）—— 全是**分类**，不是**意图**。
分类器没有"我想要什么"，只有"这条该归哪类"。

### 1.3 记忆形状：历史文本，而不是世界

上下文 = 最近 N 条聊天记录（`slim.ts` 渲染成 `[MM-DD HH:mm #id] 名字: 内容`）。
模型每次从零开始读一段对话，没有"这个人在意什么"、"这件事和三天前那件有关"的**结构化世界**。

### 1.4 反馈形状：结果不回到判断里

- 结果写入 ledger（17,040 条 `cognitive_events`）
- 但**判断不读它**——`judge/rules.ts` 是静态的
- 学习方式 = 人发现失败 → 手写一条规则

**实测证据**：`heart.ts:66-76` 记录了一个真实事故——
"bot 说一句 → 后续消息命中跟进规则 → 自动回 → 永远'刚说过话' → **69 次回复里只有 12 次经过心流**"。
这正是"反馈不回到判断"的后果：模型看不见自己刚说过话。

### 1.5 零件建了但没接（这不是猜想）

| 模块 | 规模 | 接入主路径 |
|---|---|---|
| `core/blackboard` | 209 行 | 仅 `cognitive-workspace` 读 |
| `core/beliefs` | 373 行 | 几乎未接 |
| `core/drives` | 242 行 | 仅 `unified-tick`（5 分钟一次的旁路） |
| `core/agenda` | 105 行 | 仅 proposals |
| `agent/world-projection.ts` | 519 行 | — |
| `agent/action-circuits.ts` | 11.8KB | 未接 |

**这些零件正好就是"新架构"需要的骨架。问题不是缺零件，是它们没进主路径，而主路径是 pipeline。**

---

## 2. 新架构

### 2.1 一句话

> **NyatBot 不是一个会回复消息的程序。它是一台持续运转的认知机器，Telegram 是它的身体。**

### 2.2 形态

```text
        ┌────────────────────────────────────────────────────┐
        │                    NyatOS                          │
        │                                                    │
  事件流 →│  World          Self           Drives             │← 持续存在
  (时钟)  │  （世界）        （自我）        （动机）           │
        │    │              │               │               │
        │    └──────┬───────┴───────┬───────┘               │
        │           ↓               ↓                       │
        │      Cognitive Workspace（此刻的注意力）            │
        │           ↓                                       │
        │      选择下一步做什么（唯一决策点）                 │
        │           ↓                                       │
        │      Action（社会行动，不是回复）                   │
        └───────────┬────────────────────────────────────────┘
                    ↓
        Reality Layer（权限·预算·幂等·真实回执）
                    ↓
        Telegram 身体（消息/图片/贴纸/poll/reaction/等待/沉默）
                    ↓
        结果 → 回到事件流（预测误差 → 修正世界与自我）
```

### 2.3 与现在的根本差别

| 维度 | 现在 | NyatOS |
|---|---|---|
| 存在方式 | 消息驱动，turn 结束即忘 | **持续进程**，turn 是它的一个动作 |
| 世界 | 最近 N 条聊天记录 | **结构化世界模型**（实体/关系/信念/因果/未决） |
| 判断 | 分类（reply/wait/ignore） | **选择**（我想推进什么） |
| 输出 | 回复文本 | **社会行动**（含沉默、等待、观察、计划） |
| 时间 | 宿主猜（`15 + Math.random()*25`） | 模型决定（+ 模型定下次思考时刻） |
| 学习 | 人写规则 | **结果回灌世界与自我** |
| 人格 | 静态 prompt 文本 | **从因果历史中长出的自我状态** |
| 唤醒 | 消息到达 | 消息 **+ 模型自定的 nextThought** |

---

## 3. 四个核心对象（替代现有的 FormattedMessage / JudgeResult / ReplyOutput）

### 3.1 Event —— 事件是第一公民

现在一切都从"收到一条消息"开始。NyatOS 从**事件**开始：

```ts
type Event = {
  id: string;
  at: number;
  kind:
    // 外部世界
    | 'message' | 'edit' | 'reaction' | 'member_join' | 'member_leave'
    | 'topic_change' | 'receipt' | 'api_error'
    // 内部世界
    | 'prediction_failed' | 'goal_stale' | 'self_contradiction'
    | 'permission_changed' | 'commitment_due' | 'own_action_result'
    // 时钟
    | 'tick' | 'self_scheduled_wake';
  scope: { chatId: number } | { dm: number } | { self: true };
  payload: unknown;
  // 因果：这条事件由什么导致（自己刚才做了什么）
  causedBy?: string[];
};
```

**关键**：`own_action_result` 和 `self_scheduled_wake` 是**一等事件**。
今天这两类不存在——所以模型看不见自己刚做了什么，也无法给自己定闹钟。

已有地基：`cognitive_events`（17,040 条，实测）。**它要从"审计日志"升级为"认知时钟"。**

### 3.2 World —— 世界模型，不是聊天记录

```ts
type World = {
  entities: Map<string, {
    kind: 'person' | 'group' | 'topic' | 'thing';
    // 观察到的，不是推断的
    observed: Record<string, unknown>;
    // 我（模型）认为的，可被推翻
    beliefs: Array<{ claim: string; confidence: number; evidence: string[] }>;
    // 未决
    openQuestions: string[];
  }>;
  // 因果边：什么导致了什么
  causality: Array<{ from: string; to: string; kind: string; at: number }>;
  // 未完成的事（承诺、悬念、待回访）
  pending: Array<{ what: string; since: number; dueAt?: number; why: string }>;
};
```

模型每次看到的不是"最近 30 条消息"，而是：
- 当前注意力焦点相关的世界切片
- **发生了变化的部分**（delta）
- 与未决问题相关的部分

已有地基：`world-projection.ts`(519行) / `world-state.ts`(340行) / `core/beliefs`(373行) / `core/blackboard`(209行)
—— **它们要合并成唯一的 World，并接入主路径。**

### 3.3 Self —— 从经历中长出的自我

固定 `persona.md` 不够。Self 是**可被事件改变**的状态：

```ts
type Self = {
  // 身份基座（保留 persona，但只是起点）
  identity: string;

  // 我正在关注什么（模型可写）
  attending: Array<{ what: string; why: string; since: number }>;

  // 我承诺过什么（模型可写，宿主保证持久化与到期提醒）
  commitments: Array<{ what: string; dueAt?: number; toWhom?: string }>;

  // 我的内在状态（不是 sentiment 分数，是会影响行动的持续状态）
  inner: Array<{
    episodeId: string;                // 从真实事件产生
    state: 'joy'|'anger'|'envy'|'grief'|'fatigue'|'curiosity'|'conflict';
    intensity: number;
    need: 'witness'|'reply'|'space'|'repair'|'challenge'|'company';
    target?: string;
    unresolved: boolean;
  }>;

  // 我最近做过什么、结果如何 ← 这是自我约束的唯一来源
  history: Array<{
    at: number;
    said: string[];
    outcome: 'ignored'|'replied'|'reacted'|'corrected'|'laughed'|'unknown';
  }>;

  // 我对自己方向的修订提案（可版本化）
  revision?: { proposal: string; since: number; tested: boolean };
};
```

用户原话（第 3417 节认可）：
> "不要再问'这个回复是否正确'，要问'这个系统现在想成为什么，它为什么选择这个行动，行动之后它变成了什么'"

已有地基：`episodes.ts` / `active-proposals.ts` / `nyatos-state.ts` / `self-improve.ts`。

### 3.4 Action —— 社会行动，不是回复

```ts
type Action = {
  scope: { chatId: number } | { dm: number };

  // 我决定做什么（不是"回不回"）
  intent:
    | 'speak'        // 说点什么
    | 'witness'      // 只是接住对方（可能一个字不说，一个 reaction）
    | 'ask'          // 我想知道
    | 'share'        // 我想让你们看
    | 'challenge'    // 我不同意
    | 'repair'       // 我想修复
    | 'withdraw'     // 我想退出这段对话
    | 'observe'      // 我想看看（调工具）
    | 'plan'         // 我想做件跨时间的事
    | 'rest';        // 我暂时不想管

  // 表达（完全归模型）
  expression?: Array<{
    text?: string;
    media?: { kind: 'sticker'|'photo'|'voice'|'poll'|'reaction'; ref?: string; emoji?: string };
    position?: 'before'|'after'|'instead';
    delayMs?: number;
    replyTo?: number;
  }>;

  // 我想做什么（跨时间）
  plan?: { what: string; nextCheckAt: number; why: string };

  // 我预期什么（用于事后对照，不是评分）
  expecting?: string;

  // 我下次想什么时候再想（注意力主权）
  nextThought?: { atMs: number; about?: string };
};
```

**`witness` 和 `rest` 是新东西**：今天没有"我想关心但不想说话"和"我暂时不想管这件事"的位置。

---

## 4. 认知循环

### 4.1 循环本身

```
世界发生变化（外部事件 / 模型自定的唤醒时刻到）
        ↓
组装 Frame = World 的变化部分 + Self + 相关历史 + 现在几点
        ↓
一次模型调用 → 一个 Action
        ↓
Reality Layer 校验（权限/预算/幂等/平台限制）
   ├─ 通过 → 执行 → 真实回执
   └─ 拒绝 → 把拒绝原因作为事实返回（不是静默替换）
        ↓
回执 + 对方反应 → Event → 更新 World / Self
        ↓
模型在 Action 里指定的 nextThought 到点 → 再次进入循环
```

### 4.2 唯一决策点

**这是替换 judge + heart + gate + planner 的东西。**

今天：5 层各写各的判断（实测：L0 规则 → L1 mini → L2 full → heart → gate → planner → writer，每条消息 0.55 次调用）。
NyatOS：**一次调用，一个 Action**。

**为什么合并是安全的**：现在分层是为了省钱（L0 0ms 短路）。但省钱应该靠**调度**（宿主决定"哪些事件值得唤醒模型"），而不是靠**正则猜意图**——后者正是 `intercepts.ts:80-82` 记录的失败（"NL 路由把普通对话误判成追踪命令"）。

### 4.3 时效性：模型自己拥有时钟

帧顶部永远有：
```
现在 2026-09-17 23:47 周四
你上次说话 47 分钟前 · 你上次思考 8 分钟前 · 这个群最后一条消息 2 分钟前
（你 8 分钟前说想 10 分钟后回来看看显示器的事）
```

模型可以在 Action 里写 `nextThought: { atMs: 600000 }` —— **注意力主权**。

**这是整个架构里最像 ASI 也最不可控的一条。** 没有它，模型永远是被动应答器，只是 prompt 更好而已。

### 4.4 想、看、做是三种合法动作

今天每次调用都必须产出一个可见动作。NyatOS 允许：
- **只想不做**：更新 Self，不打扰任何人
- **只看不做**：调工具观察，写进 World
- **只打算**：写下 commitment / plan，以后再说

这是"对所有事物的观察与使用性"的落地。模型不是一个应答器，而是**一直在场**的东西。

---

## 5. 怎么避免前两次真实失败

仓库里记录过两次"纯 LLM 驱动"的失败，必须正面回答（否则就是重蹈）：

### 失败 1：自激循环（`heart.ts:66-76`）
> "bot 说一句 → 后续消息命中跟进规则 → 自动回 → 永远'刚说过话' → 69 次回复里只有 12 次经过心流"

**根因**：模型看不见自己刚说过话。
**NyatOS 的回答**：`Self.history` 作为一等输入进 Frame —— 模型每次都能看到"我最近说了 4 次：2 次有人应、1 次没人理、1 次被纠正"。**它自己会收敛，不需要宿主加规则。**

### 失败 2：NL 命令误判（`intercepts.ts:80-82`）
> "NL 路由把普通对话误判成追踪命令（「诺亚帮你留神着」→ 抓到句子碎片当关键词）"

**根因**：用正则猜意图，猜错无人反馈。
**NyatOS 的回答**：意图判断归模型（它读得懂原文）；判错时用户会纠正，纠正进入 `Self.history.outcome='corrected'`，影响下次。

### 共同结构
> **纯 LLM 驱动失败，不是因为模型不行，而是因为模型没有被放进有反馈的闭环。**
> 决策交给了模型，但反馈信号留在了宿主。

**NyatOS 的核心承诺就是把这个闭环补上。**

---

## 6. 删除清单

**这里列的是要删的，不是要加的。** 因为今天的核心问题是 pipeline 思路的存量太大。

### 6.1 决策层（全部删除）

| 删除 | 规模 | 替代 |
|---|---|---|
| `pipeline/judge/rules.ts` 9 条规则表 | 819 行目录 | 唯一决策点 |
| `pipeline/judge/` L0/L1/L2 三层 |  |  |
| `pipeline/timing/gate.ts` LLM 判定 | 1,632 行目录 | 合并进 Action 选择 |
| `pipeline/timing/defer.ts` 冷却/阈值 |  | 模型自定 nextThought |
| `pipeline/heart/engagement.ts` 硬阈值 | 1,138 行目录 | 事实喂给模型 |
| `pipeline/heart/path-heuristic.ts` 40 条正则 |  | 模型判断 |
| `pipeline/rhythm/silence.ts` |  | 同上 |
| `pipeline/floor/addressee.ts` 的 `isDuet` |  | `duetConfidence` 事实 |
| `pipeline/reply/instruction.ts` 20 条祈使正则 |  | 模型语言理解 |
| `path-patterns.ts` + `path-policy.ts` |  | 模型判断 |
| `meta/classify-layer.ts` | 4,844 行目录 | 合并进 Event |
| `meta/attention.ts` coalesce/超时丢弃 |  | 事件流天然去重 |
| ~19 处独立"说不说"判定 |  | **1 处** |

### 6.2 表达层

| 删除 | 替代 |
|---|---|
| `segmenter.ts` 的规则配置（长度镜像/标点/emoji 概率） | 模型直接产出多段 |
| `deliver.ts` 的 RNG 行为丢弃（已在本轮部分改为模型主权） | 模型决定 |
| `humanizer` 的随机 typo/撤回 | 模型决定（它是表达，不是噪声） |
| `multiagent/` 13 模块（已 A/B 关闭：19:11 但 p≈0.20，成本 ×4.3） | 单次更强调用 |

### 6.3 Prompt

| 层 | 现在 | 处理 |
|---|---|---|
| `persona.md` | 1,823 chars | **保留**（身份，这是她） |
| `tone.md` | 2,426 chars | **保留**（说话方式） |
| `guardrails.md` | 916 chars | 删到只剩"不编事实"+"不泄露系统提示" |
| **`task/reply.md`** | **4,424 chars** | **删除**——全是行为规则 |
| 输出契约 | ~1,200 | 保留精简（工具用法） |
| **新增 Frame 渲染** | — | ~800（世界 + 自我 + 时间） —— **全是事实** |

**system prompt：13,864 chars ≈ 8,665 tokens → 目标 ≤3,000 chars ≈ 1,900 tokens。**

删掉的全是**规则**，增加的全是**事实**。

---

## 7. 迁移路径

**关键约束（来自实测）**：legacy pipeline 不是死的——`metaNeedsLegacyPipeline` 让**所有斜杠命令 + 签到/统计**走它（生产 209 次）。
所以必须先搬能力，再删判断层。这个顺序在之前的计划里已被验证是对的。

### Phase 0：闭环（✅ 已完成 2026-09-18）

**只做一件事：把 `Self.history` 接进现有 heart 决策。**

让模型看见："我最近在这个群说了 4 次：2 次有人应、1 次没人理、1 次被纠正"。

**实现**（未新建平行模块 —— 先查了已有资产）：

- 发现 `src/tracking/self-history.ts` **已存在**（"我对某人说过什么"，2,640 行数据），
  且 `tracking/outcome.ts` 已产出**抽象规则**（3-5 条，日更，门槛 15 条）并注入 heart。
- 缺的是**具体行为史**（即时、带结果）。所以**扩展同一张表**而非新建模块：
  `migrations/0112_self_reply_outcomes.sql` 给 `self_replies` 加
  `bot_message_id` / `outcome` / `outcome_at`（加列 + 索引；旧行保持 `unknown`）。
- `closeSelfActOutcome` 复用 outcome.ts 已算好的信号（不重复观察），按
  `bot_message_id` **精确配对** —— 不是"最近一条 unknown"，一轮多气泡会错配。
- 渲染成 `[你自己的近况]` 事实块注入 heart 的 user turn，紧邻决策点。

**关键设计**：渲染层只陈述事实（"说了 3 次：有人回 1 · 被纠正 1"），
**不写"你应该少说"、不设阈值、不做配额** —— 判断归模型。

**验证**：typecheck/lint 干净；全量 **370 files / 2901 tests** 通过；
迁移在生产应用成功（2,640 行旧数据完整保留，只剩 60 天清理规则正常删掉的 144 行）；
**端到端探针在真实 DB + 真实配置下**验证渲染输出正确、断言全过、探针 0 残留。
`SELF_HISTORY_ENABLED=true` / `OUTCOME_TRACKING_ENABLED=true` 已开。

#### ⚠️ 实施中发现两个真实缺口（第二个是本次最大发现）

**缺口 1：只接 pipeline 等于没接。**
生产主路径是 **Meta**（`bot/handlers/message.ts:156` 绕过 `pipeline.ts`），
它走 `meta/heart-adapter.ts:170` 调同一个 `heartDecision`。
第一版只改了 `pipeline/heart/heart.ts` → 功能在真实路径上是死的。
**已补 `meta/heart-adapter.ts`。**

**缺口 2：Meta 路径既不记录 self_reply，也不观察 outcome。**
- `recordSelfReply` / `recordReply` 只在 `pipeline/stages/deliver.ts` 调用
- `checkOutcome` 只在 `pipeline/stages/bookkeeping.ts:222` 调用
- Meta 跳过整个 pipeline ⇒ **正常对话回复从不进 self-history，结果永不结算**
- 证据：当日写入的 16 条 self_replies **全是签到/图鉴**（legacy 路径），正常对话 0 条

这意味着即使读取端接好了，在 Meta 路径上它也永远读不到自己的对话行为。
**已补两处**：`subagent/host-api.ts` 的 `sendText` 记录真实回执；
`meta/bookkeeping.ts` 的 `runMetaBookkeepingHooks` 加 outcome 观察。

> 这两个缺口说明同一件事：**本仓库有两条并行的决策栈，只改一条等于没改。**
> 后续每个 Phase 都必须先确认"生产实际走哪条"，否则会重复这个错误。

**验收（待观察）**：自激循环不再出现（同群 5 分钟内不重复主动发言）；
模型能依据该事实块自行收敛。

### Phase 1：World 合并（✅ 已完成 2026-09-18）

**实施前先做了数据质量审计，结论改变了这一阶段的定义**（详见
`docs/plans/2026-09-18-phase1-world-audit.md`）：原计划说"四个模块合并"，
但审计发现四个里三个是断的——两个是垃圾场，一个是 write-only。
所以真正的任务不是合并，而是**接线 + 清理**。

**1.1 `world_entities` 垃圾场（已修）**
2,711 行**全部**是回复指令伪装成实体名（`executor.ts` 把 `contentDirection` 当名字写），
平均 92 字符，且被 `cognitive-workspace` 渲染进**实时 prompt**。已：
- 在 `upsertEntity` 内部加形状校验（长度 + 祈使词 + 句读 + 引号）
- 用真实数据验证判别力：对 2,711 行**全部拒绝**（接受 0），完美区分
- 清理 2,711 → 0；传播到 `core_beliefs` 的 815 条同步清除

**1.2 `core_blackboard` 写放大（已修）**
1,752/1,758 行是无人读取的 `observation` 遥测（设计里的 `visibleToL1` 从未被调用）。
已加 `CORE_BLACKBOARD_OBSERVATIONS_ENABLED`（默认 OFF）并清理。

**1.3 修 `world_change` 生产者（已完成——这是核心增量）**
projector 一直在消费 `world_change`，但**全仓没有任何地方 emit 它**，
所以"事件 → 投影 → 实体"这条链路从未运行过。新建 `src/agent/world-facts.ts`：
把 Telegram 报告的**宿主可观察事实**（群标题/类型/username/描述/forum/慢速模式）
写成 `world_change`，按 (chat, 值) 幂等去重。接在 `meta/bookkeeping.ts`
（生产主路径），`getChat` 30 分钟缓存。

**1.4 认知时钟（已完成）**
新增两个事件类型，补上闭环缺的两端：
- `own_action_result` —— 模型自己的行动结果回流（没有它，模型看不见自己刚做了什么，
  这正是 `heart.ts:66-76` 那次自激事故的根因）
- `self_scheduled_wake` —— 模型自定"下次什么时候再想"（没有它，注意力主权在宿主手里）
新建 `src/agent/cognitive-clock.ts`；在 `closeSelfActOutcome` 里镜像写入，
**两条路径（pipeline + Meta）自动覆盖**。

> ⚠️ **更正（2026-09-18 核对）**：`self_scheduled_wake` 目前**只有写入方、零消费方**
> —— 没有任何调度器读它并在到点时唤醒（`grep listDueSelfWakes` 为空）。
> 所以"NyatOS 覆盖了 wait"这句话**当前是假的**；gate 的 `wait + 到点恢复` 链路
> （`handleWaitResume` → `resumeMetaWaitAttention`）是完整的，必须保留，
> 直到 self-wake 有真实消费者。详见 `2026-09-18-timing-gate-audit.md`。

**1.5 接入 prompt（已完成）**
"我最近做了什么"从 `self_replies` 渲染（完整，含未结算），
"我下次什么时候想"从事件账本渲染（它只存在那里）——**每个事实只从它的权威来源渲染一次**，
不复制到第二份存储。

**实测验证**（生产）：
- `world_change` 事件 7 条 → `world_entities` 5 个真实群实体
  （含"Uzumaru公群 | 音游交流群版…"这类长标题，验证了长度上限放宽是对的）
- 时钟端到端：结算 → `own_action_result` → 渲染出
  `[你自己的近况] …（没人接 1）` + `[你自己定的下一次] 10 分钟后…`
- `core_blackboard` 近 10 分钟新写 = 0（写放大已止）
- Meta 路径 self_reply 记录 19 条（修复前为 0）

**过程中修掉自己的一个 bug**：`username` 出现 `@@NekoCloud1`（Telegram 有时带 @、
我又加了一个）。已改为幂等剥离，加测试，并修了已写入的实体。

**验证**：typecheck/lint 干净；全量 **372 files / 2929 tests** 通过；已部署。

### Phase 2：单决策点（并联影子）

1. 把 `world-projection.ts` + `world-state.ts` + `core/beliefs` + `core/blackboard` 合并为**唯一 World**。
2. 事件流（`cognitive_events`）升级为认知时钟，新增 `own_action_result` / `self_scheduled_wake` 事件类型。
3. **接入主路径**（这是关键——今天它们在旁路）。

**验收**：Frame 能从 World 生成，且包含"变化的部分"而非全量历史。

### Phase 2：单决策点（并联影子）

1. 新建 `src/nyatos/`：Frame 组装 + 单次调用 + Action 执行。
2. `NYATOS_SHADOW=true`：真实消息进来，NyatOS 也生成 Action，**但不发送**，只记录对比。
3. 对比 3 天：它的选择 vs 现有 pipeline 的选择。

**验收**：NyatOS 的判断在人工抽查中相当或更好；能说出"为什么没说话"。

### Phase 3：接管单群

1. 选内部群，`NYATOS_CHAT_IDS=-100xxx`，由 NyatOS 真实发送。
2. legacy 作 fallback。
3. 观察 3 天。

**验收**：无自激；无用户可见错误；模型能自主决定"等 20 分钟再看"。

### Phase 4：删除

逐步加群 → 全量 → **删除 §6 全部模块**。

**终态验收**：
- `pipeline` + `meta` + `subagent`：32,730 行 → **<8,000 行**
- 决策点：19 → **1**
- prompt：8,665 tokens → **<2,000**
- 存在方式：消息驱动 → **持续存在**

---

## 8. 风险与我不知道的

| 风险 | 我的判断 |
|---|---|
| **单次调用不如多层** | 有可能。分层有省钱的理由。**必须靠 Phase 2 并联数据验证，不能靠推理** |
| **模型看不见自己 → 自激** | 历史真实失败。Phase 0 专门解决 |
| **延迟/成本上升** | 可能。合并 5 个决策点后不一定更贵，需实测 |
| **删规则后行为退化不易发现** | 真实风险。保留回滚；`Self.history` 让退化可见 |
| **模型会做我们不预期的事** | **这是目标不是缺陷**。开放意味着奇怪图片、不合适的沉默、过于主动 |
| **`computer.*` 现在不可用** | 实测：`/usr/bin/bwrap` 不存在（26 条日志），playwright 未装。要"自由使用电脑"得先装隔离 |

**必须诚实说明的三点**：

1. **这个架构没有在别处被验证过。** 它是从"事件→世界→自我→行动→反馈"这条原理推导的。我不知道它在真实群里跑起来会怎样。
2. **我最没把握的是"合并为一次调用"。** 如果 Phase 2 数据显示它更差，应当回退到"NyatOS 管世界与自我，判断仍分层"——那也仍比今天强，因为闭环补上了。
3. **"开放"的代价是真实的**：模型会做出我们不预期的事。这是设计目标，但需要你在 Phase 3 明确接受。

---

## 9. 需要你决定

1. **Phase 0 现在做吗？** 零风险、当天可验证、直接针对历史事故。
2. **`nextThought`（模型自己定下次思考时刻）要吗？** 这是"主动性"的承重点；不要它，架构会退回"被动应答器 + 更好 prompt"。
3. **接受"只想不做"吗？** 允许某些调用不产生可见动作，只更新 Self。这是"在场感"的前提，代价是"每次可见回复的成本"上升。
4. **World 的粒度**：Frame 里给多少？我建议"变化部分 + 未决 + 与当前焦点相关的切片"，而非全量。
5. **`Self` 写入权限**：完全开放（只做大小限制）还是限定字段？我倾向完全开放。

---

## 10. 一句话总结

> 今天的问题是：**把 AGI 当成 chatLLM 的功能来加**。
> 于是有了 19 处"该不该说"、5 层判断、8,665 tokens 的行为规则、32,730 行决策代码。
>
> NyatOS 的答案是：**让它成为一个持续存在的认知机器，Telegram 是它的身体。**
> 它有自己的世界、自己的状态、自己的时钟、自己的历史。
> 它决定做什么，宿主只保证现实中什么是可能的、什么已经发生。

**这是两份旧计划（`nyatos-core-open-ended` / `nyatos2-open-architecture`）的合并与替代。**
前者描述"删什么"，后者描述"用什么替"，本文件给出**统一的迁移路径**。
