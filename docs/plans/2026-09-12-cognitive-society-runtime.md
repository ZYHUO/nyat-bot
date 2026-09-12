# NyatBot AGI-like / ASI-like Architecture

> 状态：概念设计与研究草案
>
> 日期：2026-09-12
>
> 目标：决定 NyatBot 接下来是在旧式 chatLLM/Agent 体系上继续堆功能，还是开始建造一个真正拥有持续认知、社会模型、自我修正和长期主动性的系统。

## 1. 我们到底在造什么

NyatBot 不是：

- 一个收到消息就生成下一句的聊天模型；
- 一个 Judge → Reply 的规则流水线；
- 一个会调用工具、最后返回报告的 Agent；
- 一个由很多 prompt、cron 和 feature flag 拼起来的“伪 AGI”；
- 一个把“真的假的”“zdjd”“短一点”硬编码成模板的拟人机器人。

NyatBot 要成为的是一个**持续存在于群体环境中的认知主体**：

```text
它记得自己是谁、和谁有什么关系、过去做过什么；
它对世界、人物和群体形成可修正的内部模型；
它知道哪些是事实、哪些是猜测、哪些事情还没有解决；
它能从现实结果中发现自己错了，并改变未来行为；
它可以聊天，也可以行动，但不把每条消息都当成任务；
它可以安静，也可以主动，但主动性来自认知价值而不是定时器；
它的持续性来自状态和经验，不来自每次重新扮演一遍人格。
```

更准确的系统循环应是：

```text
消息 / 群体变化 / 任务结果 / 用户反馈
        ↓
感知与事件归一化
        ↓
当前认知状态（Self / People / Group / World / Goals / Debts）
        ↓
形成假设、目标和不确定性
        ↓
决定：说话 / 行动 / 追问 / 等待 / 观察 / 沉默
        ↓
执行工具或发送自然交流
        ↓
观察现实后果
        ↓
对比预测与现实
        ↓
更新世界模型、关系模型、自我模型和经验
```

## 2. 关键判断：哪些是老式 ChatLLM 路线

下面这些有用，但单独做它们不会让 NyatBot 产生独特智能：

- 再加一个 judge；
- 再加一个 reply mode；
- 再加一个 planner；
- 再加一个 RAG memory；
- 再加一个“反思”LLM 调用；
- 再加几个 agent role；
- 再加更多 cron；
- 根据工具名生成“正在搜索”“正在整理”；
- 根据关键词决定“真的假的”“短回复”；
- 给上下文增加更多自然语言规则。

这些属于**控制面和工程编排**，不是认知本身。

它们可以作为零件，但不能继续当作主架构。

真正重要的不是系统里有多少模块，而是：

```text
它是否形成了可持续、可证伪、可更新的内部模型，
并且这些模型是否真正改变了之后的决策。
```

## 3. 外部项目研究结论

### 3.1 Voyager

来源：

- 论文：<https://arxiv.org/abs/2305.16291>
- 项目：<https://github.com/MineDojo/Voyager>

值得借鉴的不是“让模型玩 Minecraft”，而是四个组合：

1. **可执行技能库**：技能不是自然语言心得，而是可以被检索、组合、执行和修复的代码能力。
2. **自动课程**：系统根据当前能力和环境状态产生下一个值得探索的目标，而不是等用户派活。
3. **环境反馈驱动修复**：代码执行失败、环境反馈和自检结果会进入下一轮。
4. **跨环境迁移**：能力不是绑定某次对话，换新世界仍能复用。

适配 NyatBot：

- 把 skill 从“提示词片段”升级为带触发条件、前置假设、工具权限、验证方法和失败案例的可执行能力单元；
- 用群体环境和用户关系产生“值得观察/值得验证”的课程；
- 任务失败不只记录错误，要记录失败前的错误假设以及下一次验证顺序；
- 经验必须在新用户、新群、新任务上做迁移评估。

局限：Minecraft 的行动空间、反馈和成功条件比人类社会清晰得多，不能直接把游戏里的自动规划当作社会智能。

### 3.2 Generative Agents / Smallville

来源：

- 论文：<https://arxiv.org/abs/2304.03442>
- 项目：<https://github.com/joonspk-research/generative_agents>

值得借鉴：

- **Memory Stream**：记忆不是一份静态摘要，而是持续发生的事件流；
- **Reflection**：从多条具体事件形成更高层的自我、人物和群体认知；
- **Planning**：计划由当前认知和记忆产生，不是固定流程；
- **Retrieval**：行为时同时读取近期事件和高层反思；
- **社会结果评估**：关注多智能体之间是否形成连贯行为，而不是只看单次回复质量。

适配 NyatBot：

```text
事件流 → 反思判断 → 人物/关系/群体模型 → 当前行为 → 新事件
```

不能直接照搬：Smallville 是封闭模拟环境，真实 Telegram 群有隐私、噪音、异步反馈和不确定关系，必须增加 scope、visibility、来源和置信度。

### 3.3 MemGPT / Letta

来源：

- 项目：<https://github.com/cpacker/MemGPT>
- 当前实现已迁移到 Letta 相关项目和运行时。

真正值得借鉴的方向是：

- 持久身份；
- 跨会话连续性；
- 活跃上下文与长期归档记忆分层；
- 通过 agent 自己的工具管理记忆，而不是每轮把数据库全塞进 prompt；
- 把上下文窗口当作工作内存，而不是全部大脑。

NyatBot 已有 Context Engine、scratchpad、session digest、Qdrant 和 SQLite，但现在仍是多个系统并行拼装。下一步需要统一**认知视图**，而不是统一存储：

```text
持久存储保持各自生命周期；
Cognitive Workspace 负责按 scope、visibility、provenance 和预算选择当前需要的部分。
```

### 3.4 Reflexion

来源：<https://arxiv.org/abs/2310.08560>

值得借鉴的核心不是“再调用一次 LLM 做反思”，而是：

- 行动结果形成可检索的语言反馈；
- 反馈必须影响下一次策略；
- 失败经验必须和任务情境绑定；
- 评估重点是后续行为改善，而不是反思文本是否漂亮。

NyatBot 要求经验包含：

```text
情境
原始假设
采取的行动
现实结果
哪里错了
下次先验证什么
适用范围
失效条件
```

### 3.5 CoALA：认知架构框架

来源：

- 论文：<https://arxiv.org/abs/2309.02427>

CoALA 的价值不在于提供一个现成的 Bot，而在于把语言 Agent 拆成认知模块：

- 工作记忆；
- 情景记忆；
- 语义记忆；
- 程序/技能记忆；
- 内部认知动作；
- 外部环境动作；
- 控制循环。

这比“一个 prompt + 一组 tools”更适合作为 NyatBot 的架构骨架。NyatBot 的 `scratchpad`、消息事件、Qdrant、skills、goals、self-model、Telegram adapter 应分别属于不同记忆/动作模块，不能全部混成一份 prompt。

**结论：总体架构蓝图，优先级最高；不是可直接安装的 AGI。**

### 3.6 ReAct：推理-行动-观察

来源：

- 论文：<https://arxiv.org/abs/2210.03629>

ReAct 交替进行：

```text
Reasoning → Action → Observation → Reasoning
```

它是 NyatBot 工具调用的必要基础，但本身不是长期智能。真正需要吸收的是：工具结果必须回到认知循环，下一步必须基于观察，而不是让模型连续盲调工具。

在 NyatBot 中，ReAct 还要加上：

- 事实/假设/未知分离；
- 发送消息后的社会反馈；
- 用户纠正后的计划修正；
- Telegram 权限和副作用策略。

**结论：必备底层循环，但单独使用仍是 ChatLLM Agent。**

### 3.7 SWE-agent / Aider：面向 Agent 的接口与可验证闭环

来源：

- SWE-agent：<https://github.com/SWE-agent/SWE-agent>
- Aider：<https://github.com/Aider-AI/aider>

这两个项目的共同启发是：Agent 的能力不只由模型决定，环境接口、反馈格式和验证方式同样重要。

值得借鉴：

- 为 Telegram 设计少量稳定的专用操作接口，而不是暴露一堆原始 Bot API；
- 每个动作返回来源、时间、权限和结果；
- 草稿、审批、执行、验证分离；
- 失败信息结构化返回；
- 对不可逆动作提供撤销或补偿操作；
- 任务状态、diff、成本和审计可见。

例如不要只提供一个模糊的 `sendMessage`，而是让高影响动作经过：

```text
理解请求 → 生成草稿 → 风险/权限检查 → 审批 → 发送 → 验证 → 记录
```

**结论：工程闭环价值高，但不提供社会认知本身。**

### 3.8 SIMA：跨环境动作抽象

来源：

- 论文：<https://arxiv.org/abs/2404.10130>
- 官方介绍：<https://deepmind.google/discover/blog/sima-generalist-ai-agent-for-3d-virtual-environments/>

SIMA 的启发是把高层目标和具体环境动作分离，并尝试跨环境泛化。

NyatBot 可以把 Telegram、网页、GitHub、文件系统等视为不同环境适配器：

```text
observe → interpret → choose action → execute → verify
```

高层认知不应该绑定某个 Telegram API 名称，环境 adapter 才负责具体调用。

**结论：借鉴统一环境接口，暂不照搬视觉动作模型。**

### 3.9 Dreamer / JEPA：长期研究方向

来源：

- DreamerV3：<https://arxiv.org/abs/2301.04104>
- JEPA 方向：<https://openreview.net/forum?id=BZ5a1r-kVsf>

这类工作真正启发 NyatBot 的地方是：系统可以学习“状态如何变化”，而不只是生成下一段文本。

对 Telegram 的长期研究方向：

- 发送某种消息后，群体话题如何变化；
- 用户会不会纠正、追问或沉默；
- 某个提醒是否造成打扰；
- 某个任务状态从 pending 如何转为 blocked/done；
- 某个关系或群体规范如何随事件变化。

当前不建议直接训练 Dreamer/JEPA 类世界模型。第一步应先积累结构化状态转移数据和 prediction error，再评估是否值得训练专门模型。

**结论：研究启发高，近期工程优先级低。**

### 3.5 AutoGPT / OpenHands / CodeAct 系项目

这些项目最值得借鉴的是工程边界：

- server-side agent state；
- backend / sandbox / channel 分离；
- checkpoints；
- cost / action / failure 可观测；
- 中途交互和恢复。

它们大多数仍然是：

```text
LLM → tool → observation → LLM
```

真正的差异不在于多一个工具，而在于 NyatBot 是否有持续的 Self / People / Group / World model，以及是否能从真实社会反馈修正这些模型。

## 3.11 项目研究后的综合判断

没有一个现成开源项目可以直接给 NyatBot “AGI”。每个项目只解决了认知的一部分：

```text
CoALA         给出认知模块边界
Letta         管理持久身份与上下文资源
Generative Agents  建立事件流、反思和社会行为
Voyager       累积可执行技能并跨环境迁移
Reflexion     把失败转成下一次可用的经验
ReAct         让行动基于观察而不是臆测
CodeAct       提供可组合的动作空间
SWE-agent     设计适合模型使用的环境接口
Aider         提供验证、审计和回滚闭环
Dreamer/JEPA  提供长期世界模型的研究方向
```

NyatBot 的独特性不能来自“把这些名词都放进 README”，而应来自一个适合群聊社会环境的组合：

```text
社会事件流
+ 持久的 Self / Person / Group / World model
+ Cognitive Debt（未解决承诺、矛盾和纠正）
+ Prediction Error（行动后果与预期的差异）
+ 可迁移的 Telegram skill
+ 严格的 scope / privacy / approval
```

真正的成功标准是：系统在新的对话、新的用户、新的群体和新的任务中，表现出比初始版本更好的判断，并且能解释这种改善来自哪一段真实经验。


暂名：**Cognitive Society Runtime（CSR）**。

它不是在现有 judge/reply 上再包一层，而是把现有系统重新分成五个独立平面。

### 4.1 Perception Plane：感知平面

负责把 Telegram 和内部事件统一成认知事件：

```ts
MessageReceived
MessageEdited
UserCorrection
UserGoalChange
UserStop
TaskObservation
ToolFailure
BotDelivery
UserReaction
UserFollowup
WorldChange
```

感知平面不决定回复，不调用主模型，只保证：

- 去重；
- source / chat / user 绑定；
- 时间顺序；
- privacy scope；
- 事件可追踪；
- 原始事实与模型解释分离。

### 4.2 World Model Plane：世界模型平面

维护几个互相连接但不混淆的模型：

#### Self Model

```text
我是谁
我最近在意什么
我擅长什么
我经常在哪里判断错
我欠了谁什么
我正在形成哪些看法
```

#### Person Model

```text
这个人如何表达
可能的意图模式
信任与关系变化
偏好和边界
被纠正过的事实
尚未解决的期待
```

#### Group Model

```text
群里谁和谁有关系
谁是权威/活跃者/挑错者/调停者
群体黑话和规范
话题的生命周期
什么时候插话会破坏对话
```

#### External World Model

```text
项目
服务
版本
事件
来源
时间有效性
冲突事实
```

这些模型的每个判断都应有：

```ts
belief
source
confidence
formedAt
lastConfirmedAt
scope
supersededBy
```

### 4.3 Cognitive Debt Plane：认知债务平面

这是 NyatBot 的一个核心差异化方向。

每当 bot：

- 做出未验证的判断；
- 对用户作出承诺；
- 遇到事实冲突但暂时放过；
- 被用户纠正；
- 暂停一个任务；
- 说“之后再查”；
- 发现自己可能误解了目标；
- 发送了部分结果但未完成整体目标；

就产生一条认知债务：

```ts
interface CognitiveDebt {
  id: string;
  chatId: number;
  ownerUid?: number;
  kind: 'promise' | 'uncertainty' | 'correction' | 'unfinished_task' | 'conflict' | 'stale_belief';
  statement: string;
  sourceEventIds: string[];
  priority: number;
  confidence: number;
  status: 'open' | 'resolved' | 'superseded' | 'expired';
  nextCheckAt?: number;
}
```

下次收到相关消息时，不只是检索相关记忆，还要检查：

```text
当前事件是否偿还了某条债务？
是否应该主动修正？
是否应该承认上次错了？
是否应该重新核实？
```

这让 bot 不只是“记得过去”，而是“记得自己尚未解决什么”。

### 4.4 Simulation Plane：预测平面

重要行动前，系统维护一个轻量的反事实预测：

```text
如果我这样说，对方可能如何理解？
如果我不说，会错过什么？
如果我现在执行，会不会越权或方向错误？
如果我先问一句，未来成本是否更低？
```

不是要求每条消息都生成多份候选，而是对高价值/高风险事件启用。

行动后比较：

```text
prediction
vs
actual user reaction / task outcome / correction
```

形成 prediction error，更新 Person/Group/Self model。

### 4.5 Agency Plane：行动平面

行动平面不再是单一 `judge → reply`，而是统一动作空间：

```ts
type AgencyAction =
  | { type: 'speak'; reason: string }
  | { type: 'act'; goal: string }
  | { type: 'ask'; question: string }
  | { type: 'wait'; reason: string }
  | { type: 'observe'; target: string }
  | { type: 'remember'; fact: string }
  | { type: 'correct'; debtId: string }
  | { type: 'stop'; reason: string };
```

Legacy reply、Heart、Meta 和 CodeAct 最终都应该逐步收敛到这个动作空间，但不要求一次性重写。

## 5. 旧架构哪些要保留，哪些要拆

### 保留

- Telegram sender 和分片安全；
- Redis/BullMQ durable queue；
- CodeAct sandbox；
- checkpoint；
- interrupt；
- Qdrant/FTS 记忆；
- evidence gate；
- Context Engine 的渲染和 manifest；
- existing visibility/privacy layer；
- skill lifecycle 和验证机制。

### 降级为兼容层

- 旧 Judge L0/L1/L2：保留用于 legacy fallback 和安全快速决策；
- Heart：保留作为低成本社会注意力候选器；
- Meta：逐步改成高层 agency coordinator，不再直接编写固定回复方向；
- ReplyMode：不再主导回复生成，最终移除或只用于离线评估；
- Humanizer：只做低风险投递保护，不再承担“像真人”的主要责任；
- TaskProgress：只做客观故障和生命周期观测，不生成语义阶段话术。

### 需要拆掉的耦合

- “发过任意文字 = 任务完成”；
- “工具名 = 用户可见阶段”；
- “关键词 = 情绪或回复形态”；
- “每条消息都经过同一套 judge/reply 层”；
- “所有状态都通过 prompt 自然语言拼接表达”；
- “自我反思文本 = 自我模型”。

## 6. 最独特、最值得先做的三个模块

### 第一：Cognitive Debt

立刻提升连续性和责任感，复用现有：

- goals
- scratchpad
- session digest
- task evidence
- promise backstop
- reply outcomes

第一阶段不用新数据库，可以先用 SQLite/Redis 组合做 scoped store。

### 第二：Prediction Error Loop

将用户后续反应、纠正、任务成败和关系变化统一为“预测误差”，反馈给：

- Person model
- Group model
- Self model
- skill/experience verifier

这比单纯 ASI 自评分更有学习价值。

### 第三：Group Social World Model

NyatBot 最有场景优势的独特能力：

```text
谁和谁是什么关系
哪些话题适合插入
哪些梗属于谁
谁会接我的话
我说这句话会不会破坏两个人的交流
```

这不是通用聊天模型默认拥有的能力，而是 NyatBot 可以长期积累的差异化资产。

## 7. 研究项目的吸收清单

| 项目/方向 | 吸收 | 不照搬 |
|---|---|---|
| Voyager | 可执行 skill、自动课程、错误修复、跨环境迁移 | Minecraft 明确环境和目标假设 |
| Generative Agents | memory stream、reflection、planning、社会模拟 | 小型封闭模拟环境 |
| MemGPT/Letta | 持久身份、分层记忆、上下文分页 | 把 memory 当作完整认知 |
| Reflexion | 失败反馈影响后续策略、可验证改进 | “再调用一次反思模型”本身 |
| AutoGPT | durable runs、观察、调度和成本可见 | 无限 prompt loop |
| OpenHands/CodeAct | agent server、sandbox、恢复、工具协议 | 把执行器当成认知主体 |
| MetaGPT/CAMEL 类多 Agent | 专业分工和协议边界 | 用角色 prompt 假装形成群体智能 |

## 8. 效率设计

新的架构不能靠每条消息多调用几个模型。

### 快路径

普通闲聊：

```text
事件归一化
→ 读取少量 Self/Person/Group 状态
→ 主模型自然决定说不说
```

不额外调用 judge、planner、critic。

### 深路径

只在以下条件启用认知循环：

- 用户明确要求行动；
- 有开放目标或认知债务；
- 多步工具任务；
- 事实冲突；
- 用户纠正；
- 高风险或高副作用行动；
- 预测误差异常。

### 后台路径

异步完成：

- 经验蒸馏；
- 关系模型更新；
- 群体模型更新；
- 认知债务扫描；
- prediction error 计算；
- skill 验证；
- 过期记忆淘汰。

不要阻塞 Telegram 主回复。

## 9. 评估：不要用“像不像 AGI”的主观口号

建立三种评估。

### 持续性评估

- 隔天是否接得上未完成目标；
- 是否记得用户纠正；
- 是否会回到认知债务；
- 是否会重复已知错误；
- 是否知道自己不确定。

### 社会智能评估

- 同一句话在不同关系/群体语境下能否不同处理；
- 是否知道什么时候不插话；
- 是否能预测某种回复会造成的后果；
- 用户说坏消息时是否不会机械套惊讶模板；
- 是否能修复一次社交失误。

### 行动智能评估

- 计划是否随证据变化；
- 是否主动寻找反例；
- 失败后是否换路线；
- 是否能中途部分交付；
- 是否能等待澄清后恢复；
- 新任务是否能迁移旧 skill 但不过拟合。

这些评估要使用 held-out 情境和真实历史回放，不要只看单次回复分数。

## 10. 实施路线

### Phase A：当前阶段收口

- 完成 delivery kind / final / waiting 生命周期；
- 完成 checkpoint 恢复；
- 完成 workspace scope/provenance/evidence；
- 删除运行时固定阶段播报；
- 删除回复模式硬注入；
- 建立 runtime event 观测。

### Phase B：Cognitive Debt

- 设计 debt schema；
- 从 promise、correction、waiting、uncertainty、unfinished task 自动产生债务；
- 每次新事件匹配相关债务；
- 支持 resolve/supersede/expire；
- 加回放测试。

### Phase C：Self/Person/Group Model

- Person model 从 profile 升级为可证伪行为假设；
- Group model 统一关系、角色、规范、话题生命周期；
- Self model 绑定证据、范围、过期时间和撤销条件；
- 不直接把原始 reflection 全部塞 prompt。

### Phase D：Prediction Error

- 行动前生成可选预测；
- 行动后收集用户反应/任务结果；
- 计算 prediction error；
- 只在多次证据后更新模型；
- 做 ON/OFF held-out 实验。

### Phase E：Agency Runtime

- 统一 AgencyAction；
- legacy/Heart/Meta/CodeAct 逐步成为不同执行后端；
- 主模型决定 action，运行时校验权限、scope、evidence 和 side effects；
- 最终逐步弱化 Judge → Reply 主路径，但不一次性删除 legacy fallback。

## 11. 当前最重要的判断

我们不是要把旧 bot 变得更会“像真人说话”。

我们要构建的是：

```text
一个在群体环境中持续存在的认知系统，
它拥有自己、他人、群体、世界、目标、债务和误差的模型，
能行动、能观察、能等待、能修正，
并让现实反馈改变它下一次的判断。
```

如果一个改动只让回复更像模板、更短、更会播报状态，
但没有增加上述任何一种持续认知能力，
它就不应该被称为 AGI/ASI 进展。

## 12. 参考资料

- Voyager：<https://arxiv.org/abs/2305.16291>
- Generative Agents：<https://arxiv.org/abs/2304.03442>
- MemGPT / Letta：<https://github.com/cpacker/MemGPT>
- AutoGPT：<https://github.com/Significant-Gravitas/AutoGPT>
- OpenHands：<https://github.com/All-Hands-AI/OpenHands>
- NyatBot evidence-driven agent notes：`docs/agent-evidence.md`
- NyatBot Meta/Subagent architecture：`docs/meta-subagent/README.md`
- NyatBot existing AGI plans：`docs/plans/2026-08-06-agi-level4-experience-goals.md`, `docs/plans/2026-08-16-agi-level6-task-valve-smart.md`
