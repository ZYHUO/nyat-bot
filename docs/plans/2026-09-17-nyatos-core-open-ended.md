# NyatOS Core：开放式认知重构计划

> 状态：待审。本计划**不**在当前框架上叠加模块，而是拆掉规则层与决策分裂，让模型接管表达主权。
>
> 前置审计：本计划的每一条结论都有代码或生产日志证据；标注 `已验证` 的条目我已亲自复核。
> 撰写者：接续 Codex 会话 01a0a5c5 的 agent。日期 2026-09-17。

---

## 0. 结论先行

NyatBot 现在**不是一个认知系统**，而是一个 chatLLM 外面套了三层脚手架：

1. **决策分散**：13 处（pipeline）+ 6 处（meta）独立判定"说不说"，互相不知道对方存在。
2. **规则代判断**：`judge/rules.ts`、`engagement.ts`、`silence.ts`、`addressee.ts`、`path-heuristic.ts`、`instruction.ts` 用正则和魔法数字替模型做行为决策。
3. **prompt 当牢笼**：~20 处独立 prompt 组装点，`behavior-style.md` 用 if-then + few-shot 教模型"什么时候安静"，`guardrails.md` 用禁令约束表达形式（"禁止 HTML、标题语法、编号清单"）。

同时生产环境有**两个真实 bug 正在损害用户**（见 §1.1）。

用户的意图很明确：**摒弃 agent / chatLLM 的思路，做一个开放式的、模型拥有主权的东西。** 这份计划就是为此写的。

核心命题：

> **宿主只定义现实（scope、能力、预算、幂等、真实回执），模型定义行为（说什么、怎么分段、何时发、配什么媒体）。**
>
> 现在的代码把这两者搞反了：宿主在决定行为（规则引擎），模型在猜测现实（prompt 里塞满"你不能…"）。

---

## 1. 审计发现（均有证据）

### 1.1 生产 bug 核查（含一次更正）

> **更正记录（2026-09-17）**：本计划初稿声称"22 条真实用户命令被 floor 静默吃掉"，并把"删除 legacy pipeline"列为可立即执行的清理项。**该结论错误，已更正。**
>
> 实际核查：先查 `bot_command_profiles` 表（NyatBot 学习**其他 bot** 命令的库），13 种被丢命令中：
>
> | 命令 | 归属 |
> |---|---|
> | `/play` | `AnitaBriso_bot` |
> | `/pvp` | `DickGrowerBot` |
> | `/new` | `maimai_liz_bot` |
> | `/dc` | `KinhRoBot` / `nmnmfunbot` |
> | `/spam` `/music` | `nmnmfunbot` / `Music163bot` |
> | `/geo` | `uzumaru_geoip_bot` |
> | `/hb` `/in` `/muuu` `/muu` | 无画像（同样是群内其他 bot 的命令） |
> | `/cards` | **NyatBot 自己的白名单命令**（唯一真 bug 命中） |
>
> **结论：floor 丢弃其他 bot 的命令是正确行为**——NyatBot 本就不该抢答不属于自己的命令。真正的 bug 面缩小到 `/cards` 这一类** NyatBot 自有白名单命令**。

**Bug A（修正后）：`/cards` 等自有命令可能被 floor 提前 silence**

- 链路：`metaNeedsLegacyPipeline`（`meta/ingress-intercepts.ts:32`）把所有 `/` 开头的消息交回 legacy → `pipeline.ts:377` 的 floor 判定 → `ambient` 时 `return`，早于 `post-judge.ts:178` 的 `tryMuteCommandIntercepts`。
- 但 `/cards` 是白名单命令（`judge/rules.ts:39`）。L0 在 floor **之后**才跑，所以命令确实会被提前吞掉。
- 影响面：**仅限 NyatBot 自有白名单命令**（`/cards` 已实测；`/game` `/wish` `/checkin` 等同理，取决于是否被 floor 判 ambient）。
- 已修复：`pipeline.ts:377` 增加 `!isSlashCommandEntry` 守卫（见 §1.3）。放行安全，因为 L0 的 `getCommandName` 只对"指向本 bot 且在白名单内"的命令返回 REPLY，其余判 `unknown_command` → IGNORE。

**Bug B：`isEdit` 静默改道到另一条路径。已验证**

`message.ts:156` 要求 `!isEdit`，所以**编辑过的消息**绕过 Meta 的 coalesce/attention，掉进 `processPipeline` 的完整旧链路。这条路径不是死的（见下），但编辑消息与普通消息走两套不同决策栈仍是设计缺陷。

### 1.2 决策分裂（为什么"自主性"上不去）

生产上**同一批问题被两套独立实现回答**：

| 决策 | pipeline 侧 | meta 侧 |
|---|---|---|
| 该不该说话 | `heart/heart.ts:207-230`、`judge/judge.ts:130/173/190`、`timing/gate.ts:233-320` | `meta/heart-adapter.ts:170`、`meta/timing-adapter.ts:198`、`meta/dispatch-gate.ts:132` |
| 睡眠/静默 | `pipeline.ts:250-284` | `meta/bookkeeping.ts:49-60` |
| 独角戏抑制 | `heart/engagement.ts:63-90` | `meta/heart-adapter.ts:108` |
| 冷却/refractory | `heart/heart.ts:98-139` | `meta/heart-refractory.ts:22-75` |
| 参与预算 | `heart/engagement.ts:92-149`（硬阈 0.12） | `meta/heart-adapter.ts:128` |

而且 **`runTimingGate` 对同一条 Meta 消息被调用两次**（ingest 期 `timing-adapter.ts:198` + dispatch 期 `dispatch-gate.ts:132`）。已验证。

叠加的重复决策：
- **规则 → LLM → 再规则**：`judge/rules.ts:225` 的 `recent_reply` 判 IGNORE → `heart/heart.ts:74` 降级推翻 → 回退时 `judge.ts:131` 经 `demoteConversationalL0` 让同一条规则复活。**降级集合还被硬编码两份**（`heart.ts:69,74` 与 `judge.ts:16-21`）。
- **"要不要用工具"答三遍**：`needsLookup` 约 40 条正则（`heart/path-heuristic.ts:15-55`）+ `path-patterns.ts:8-60` 的 20+ 正则配 Redis 分数表 + planner LLM（`reply.ts:715-770`）。
- **命令意图检测两遍**：`intercepts.ts:186` 与 `reply.ts:344` 各调一次 `detectCommandIntent`。
- **沉默决策做两遍**：L0/Heart/gate 批准说话后，写手自己还能吐 `{"action":"silent"}`（`parser.ts:447` → `reply.ts:1100` → `deliver.ts:585`）。

### 1.3 规则引擎在做行为决策（不是事实）

| 位置 | 决定什么 |
|---|---|
| `judge/rules.ts:125-241` | 9 条 L0 规则：`bot_fatigue`(≥8 轮)、`recent_reply`、`at_others`、`unknown_command`→IGNORE … |
| `judge/rules.ts:97-101` | `looksLikeStickerDislike` 正则 → 强制 REPLY |
| `heart/engagement.ts:92-149` | 硬沉默：share≥1/3、replies5m≥4、velocity≥60 |
| `heart/engagement.ts:63-90` | `isBotMonologueTrail`（窗口内 bot ≥ 半）→ 沉默 |
| `rhythm/silence.ts:32-58` | `self_chase(<60s)` / `hot_lurk(≥10/分)` / `dead_chat(6h)` |
| `floor/addressee.ts:17-40,53-91` | `isDuet`（6 条严格交替、恰好 2 人）→ 禁止插话；`botDistance≤3` → to_me **并跳过 judge** |
| `reply/instruction.ts:31-84` | ~20 条祈使正则 → 服从模式 / 禁止沉默 |
| `reply/reply.ts:128-146` | `detectExactReplyCountRequest` → 强制发 N 条 |
| `deliver.ts:79` / `:506` | 贴纸冷却=3 / 投票每日上限 2 |

**关键判断：这些规则本身不是"坏代码"——它们是在模型判断力不足时补位的。** 但它们把行为固定成了表格，让模型无法根据真实语境自行裁决，也让"自主性"永远停留在参数调优层面。

### 1.4 prompt 当牢笼

- `prompts/identity/behavior-style.md`：`## 什么时候安静` / `## 什么时候参与` 用 if-then + 5 个 few-shot 场景教模型何时不出声。
- `prompts/safety/guardrails.md`：`## 输出红线` — "禁止 HTML、标题语法、编号清单、排比小作文"。
- `src/subagent/executor.ts:55-140`：给模型注入约 **18KB** 行为准则，含大量"禁止""必须""别"。
- **~20 处 prompt 组装点**，只有 `prompt-builder.ts:62` 算真正的 builder，其余各自为政：`heart/decision.ts:122-150`、`timing/gate.ts:325`、`judge/micro.ts:131`、`path-reflection.ts:34`、`planner/planner.ts:28`、`planner/agentic-loop.ts:59`、`subagent/executor.ts:424/1194`、`meta/session.ts:930`、`vision.ts:147`、`directive.ts:27`、6 个 `multiagent/*.ts` …

### 1.5 死代码与僵尸配置

**只被测试引用、src 零调用的模块（已验证）：**

```
src/pipeline/reply/reply-mode.ts        （src 引用 0，tests 4）
src/eval/spot-the-bot.ts                （src 引用 0）
src/eval/agi-like-evaluator.ts          （src 引用 0）
src/eval/agency-canary.ts               （src 引用 0）
src/eval/long-horizon-report.ts         （src 引用 0）
src/agent/agency-control-adapters.ts    （src 引用 0）
src/shared/soft-truncate.ts             （src 引用 0）
```

**29 个 env flag 声明后从未被 src 引用**，包括 `REPLY_MODE_ENABLED`、`TURN_UNIFIED_DECISION_ENABLED`、`CORE_BLACKBOARD_ENABLED`、`PROACTIVE_PRESSURE_ENABLED`、`GOAL_LONG_TERM_ENABLED`、`TASK_MAX_ROUNDS` 等。

**已失效的规则名仍在授予豁免**：`judge/rules.ts:212-220` 记录热群 RNG 与 `followup_to_bot` 正则已于 2026-08-06 删除，但 `pipeline/shared.ts` 的 `DIRECT_INTERACTION_RULES` **仍列着** `followup_to_bot`/`active_conv_engage`——死名字还在给 gate/stale/指令层开旁路。

**非确定性行为丢失藏在投递层**：`deliver.ts:614` 的 3% typing-ghost"正在输入然后什么都不发"、`deliver.ts:277` 的 3%/30% 迟到概率。这类代码读日志时极易误判成 bug。

---

## 2. 根本诊断：三层错位

### 2.1 表达主权错位

真人决定自己说什么、分几段、什么时候发、配不配图。现在这些由**代码**决定：
- 分不分段 → `segmenter` 的规则配置
- 何时发 → `delay`/`typing`/`humanizer` 的魔法数字
- 配不配图 → `stickerPolicy.sendPosition`、冷却计数
- 发不发 → 13 处判定点

模型只在"已决定要发、已决定分几段"之后，负责**填充文本**。

### 2.2 判断力错位

规则引擎代替模型判断"这个场合该不该说话"。这些规则是**用过去的失败案例硬编码出来的补丁**（"接错比不接更尴尬"→ 默认 pass）。结果是 bot 的行为上限被规则表锁死，无法通过经验成长。

### 2.3 现实与行为的边界错位

- 宿主**应该**管的（scope、权限、预算、幂等、真实回执）→ 部分管了，但和 rollout 开关混在一起（如 `AGENCY_*_TRANSPORT_ENABLED` 同时管"能不能发"和"用哪条链路发"）。
- 宿主**不该**管的（该不该说话、怎么表达）→ 管得过多。

---

## 3. 目标架构：NyatOS Core

### 3.1 一句话

**一个持续运行的认知进程，拥有唯一的事件入口、唯一的决策点、唯一的表达出口；宿主只做现实校验。**

### 3.2 形态

```
                    ┌─────────────────────────────────────┐
   Telegram ────────┤                                     │
   Scheduler ───────┤   NyatOS Core（唯一认知回路）        │
   Tool receipt ────┤                                     │
   Self tick ───────┤   observe → frame → decide → act     │
                    │      ↑                      ↓       │
                    │   consequence ←──────── receipt     │
                    └─────────────────────────────────────┘
                                    │
                    ┌───────────────┴───────────────┐
                    │  Host Reality Layer           │
                    │  scope / capability / budget  │
                    │  idempotency / receipt        │
                    └───────────────────────────────┘
                                    │
                    ┌───────────────┴───────────────┐
                    │  Adapters                     │
                    │  telegram / media / tool      │
                    └───────────────────────────────┘
```

### 3.3 关键设计原则

**P1：单一决策点。** 一个问题只有一个地方回答。删除重复决策栈，而不是让它们投票。

**P2：模型拥有表达主权。** 说什么、分几段、什么时候发、配什么媒体、@ 谁——模型决定。宿主不再有 `segmenter` 规则表、`stickerPolicy` 冷却、`humanizer` 概率。

**P3：宿主只否决现实。** 宿主可以拒绝（超长、无权限、超预算、重复），但**不能改写表达**。拒绝要作为可观察结果返回给模型，让模型换方案——而不是静默替换成宿主认为合适的版本。

**P4：规则退化成事实。** `engagement.ts` 的"群内 bot 占比 1/3"不该决定沉默，但可以作为**观察值**放进 frame 让模型自己判断。规则表 → 事实表。

**P5：prompt 是最简工具说明，不是行为守则。** 保留：我是谁（persona）、语气（tone）、可用工具及用法。删除：什么时候该说话、什么时候安静、输出格式禁令。

**P6：经验驱动，不是规则驱动。** 结果（被无视、被怼、被夸、被纠正）进入 frame 影响下一次判断，而不是变成新的硬编码规则。

**P7：开放性。** bot 可以有自己的兴趣、节奏、困惑、表达欲；可以不同意、拒绝、暂时离开、要求反馈。这些是 action kind，不是需要审批的例外。

### 3.4 Core 的数据形态

```ts
// 唯一入口：一切都变成 observation
type Observation = {
  scope: CognitiveScope;
  source: 'telegram' | 'scheduler' | 'tool' | 'self' | 'replay';
  kind: 'message' | 'edit' | 'reaction' | 'receipt' | 'tick' | 'outcome';
  at: number;
  payload: Record<string, unknown>;
};

// 唯一决策产物：模型提出的行动（含表达形式）
type Intent = {
  scope: CognitiveScope;
  anchoredAt: string;            // 触发 observation id
  // 模型自己决定说什么、怎么分、何时发、配什么
  expression: {
    bubbles: Array<{
      text?: string;
      media?: { kind: 'photo'|'sticker'|'voice'|'poll'|'forward'; ref?: string; purpose: string };
      delayMs?: number;          // 模型自定节奏
      replyTo?: number;
    }>;
    silenceReason?: string;      // 选择不说时，如实记录为什么
  };
  expectedEffect?: string;
  followUp?: { whenSec: number; reason: string };
};
```

宿主对 `Intent` 只做**现实校验**：scope 是否匹配、能力是否具备、预算是否够、是否重复。校验失败 → 返回结构化拒绝原因，模型重新决策。

---

## 4. 删除清单（具体到文件）

### 4.1 立即删除（无引用）

```
src/pipeline/reply/reply-mode.ts
src/eval/spot-the-bot.ts
src/eval/agi-like-evaluator.ts
src/eval/agency-canary.ts
src/eval/long-horizon-report.ts
src/agent/agency-control-adapters.ts
src/shared/soft-truncate.ts
```

连同它们的测试文件。

### 4.2 删除规则层（行为决策 → 交给模型）

| 文件 | 处置 |
|---|---|
| `pipeline/judge/rules.ts:125-241` | **删规则表**。保留 `isMentioningSelf` 等**事实提取**函数（它们是"这条消息是否 @ 了 bot"，是事实不是决策）。 |
| `pipeline/judge/rules.ts:97-101` | 删 `looksLikeStickerDislike` 正则；贴纸被嫌弃是模型能从上下文读出来的。 |
| `heart/engagement.ts:63-149` | 改为 **frame 事实**：`botShareRatio`、`repliesIn5m`、`velocity`、`botMessageRatioInWindow` 作为观察值注入，不再自行判定沉默。 |
| `rhythm/silence.ts:32-58` | 同上，改成 `selfChaseGapSec`、`hotLurkRate`、`deadChatHours` 事实。 |
| `floor/addressee.ts:17-40` | 删 `isDuet` 硬判定；`isDuet` 退化为 `duetConfidence` 事实。 |
| `heart/path-heuristic.ts` | 删 `needsLookup` 约 40 条正则。 |
| `path-patterns.ts` + `path-policy.ts` | 删正则 + Redis 分数表。工具需求由模型在单一决策点判断。 |
| `reply/instruction.ts:31-84` | 删 ~20 条祈使正则；指令服从是模型的语言理解。 |
| `reply/reply.ts:128-146` | 删 `detectExactReplyCountRequest`。 |
| `nl-commands.ts` 的 intercept 分支 | 保留功能命令（`/checkin` 等真实功能），删"意图猜测"部分。 |

### 4.3 删除重复决策栈

- 删除 `meta/timing-adapter.ts` 的 ingest 期 gate 调用（`timing-adapter.ts:198`）**或** `meta/dispatch-gate.ts:132`，只留一个。
- 统一 `heart/heart.ts:69,74` 与 `judge/judge.ts:16-21` 两份降级集合（若规则层已删，此问题自动消失）。
- 删除 `pipeline.ts` 的 legacy 分支（见 §4.4）。

### 4.4 legacy pipeline 不能直接删除（更正）

> **更正**：初稿写"Meta 已是唯一入口，可删 `pipeline.ts` 的 legacy 决策链"。**错误。**
>
> 事实：`metaNeedsLegacyPipeline`（`meta/ingress-intercepts.ts:26-37`）会**故意**把两类消息送回 legacy pipeline：
> - `:32` 任何 `/` 开头的消息
> - `:38` 被寻址（DM 或直接互动）且 `detectCommandIntent().kind === 'llm'`（签到/统计类）
>
> 生产实证：`Meta path: slash/checkin-stats → legacy pipeline` **209 次**。
>
> **legacy pipeline 不是死代码，它在服务"全部斜杠命令 + 签到/统计"。**

**缺口在"执行能力"，不是"判断逻辑"。** Meta/CodeAct 沙箱（`subagent/host-api.ts`）只有 `sendText`/`sendFinal`/`sendSticker`/`sendFile`/`sendPhoto`/`sendVoice`/`react`/`sendPoll`；而 legacy 侧独占：

| 能力 | legacy 位置 | Meta 侧 |
|---|---|---|
| humanizer（延迟/typo/撤回重发/后补编辑） | `deliver.ts:387-430`、`:786-1123` | ✗ 无 |
| segmenter 代码分句（559 行 + 群风格 overlay） | `reply/segmenter.ts` | ✗ 无（靠模型自己分条） |
| 引用 quote 概率抑制 | `deliver.ts:~760` | ✗ 无 |
| 贴纸冷却 + per-chat 去重 | `deliver.ts:78-99` | 部分（需 fileId，无冷却） |
| 投票每日上限 2/群 | `deliver.ts:514-548` | `sendPoll` 有，无上限 |
| react emoji 白名单 | `reply/reaction-emoji.ts` | `react()` 有，无白名单 |
| 13 个白名单命令 | `judge/rules.ts:27-43` | **只覆盖 6 个分支** |
| 签到/统计数据注入 + 卡片渲染 | `reply.ts:343-386` | ✗ 无 |
| roster/画像/黑话/往事注入 | `reply.ts:394-616` | 部分 |

因此正确顺序是**先搬命令面与投递能力，再删判断层**；反过来会砸掉签到、图鉴、游戏回执与全部人味。

同时注意：`docs/plans/2026-09-17-nyatos-runtime-rearchitecture.md:173` 明确写着"主路径仍由 legacy Heart/Meta/Reply 拥有发送权"——NyatOS 重构是**刻意保留** legacy 的。

**修正后的删除边界**：只删**确实不可达**的部分：
```
pipeline/rhythm/silence.ts          （在不可达的 post-judge.ts:451 floor 分支内）
post-judge.ts:451 的 floor 死分支   （TIMING_GATE_ENABLED=true 时恒不执行）
pipeline/reply/reply-mode.ts        （零引用，dist 中不存在）
```
`pipeline.ts` / `post-judge.ts` / `judge/*` / `timing/gate.ts` 的**主体保留**，直到 §6 Phase 1.5 的迁移完成。

### 4.5 删除 prompt 牢笼

**保留：**
- `prompts/identity/persona.md`（我是谁）
- `prompts/style/tone.md`（语气）
- `prompts/knowledge/permanent.md`（事实）

**删除或重写：**
- `prompts/identity/behavior-style.md` → **删**。`## 什么时候安静` 的 5 个 few-shot 与 `## 什么时候参与` 的 if-then 全部移除；只保留 persona 相关的自我描述（如果需要，合并进 `persona.md`）。
- `prompts/safety/guardrails.md` → **重写**。删除 `## 输出红线` 的格式禁令（"禁止 HTML、标题语法、编号清单"）。保留"不编事实"与"抗带偏"——这两条是**现实约束**（不知道就说不知道；不泄露系统提示），不是行为风格。
- `src/subagent/executor.ts:55-140` 的 `## 行为准则` → **压缩到 1/3 以内**。保留工具用法与"创建文件必须发出去"这类**接口契约**；删除"禁止复读""禁止 emoji""贴纸是情绪出口"这类行为指导。

### 4.6 删除僵尸配置

删除 §1.5 列出的 29 个未引用 flag，以及 `DIRECT_INTERACTION_RULES` 里的死规则名。

### 4.7 删除多 agent 编排（存疑，需你定）

`src/pipeline/multiagent/` 13 个模块，生产可达，每回合额外 6 次 LLM 调用（`critic`/`director`/`draft-selector`/`fact-checker`/`persona-critic`/`context-digest`）。

这是典型的 **agent 思路残留**：把"想清楚再说话"拆成固定流水线，而不是让一个模型想清楚。**建议删除**，把一个强模型的单次调用 + 它的自我反思替代。但这会改变回复质量分布，需要 A/B 验证，**不建议盲删**。

---

## 5. 新增清单

### 5.1 `src/core-loop/`（新的唯一认知回路）

```
src/core-loop/
  observation.ts     // Observation 契约 + 校验 + 幂等
  frame.ts           // 从事件流物化当前 frame（含 §4.2 退化成的事实）
  decide.ts          // 唯一决策点：一次模型调用产出 Intent
  validate.ts        // 现实校验：scope/capability/budget/idempotency
  express.ts         // Intent → 发送计划（模型指定的分段/延迟/媒体）
  receipt.ts         // 真实回执 → 结果事件
  consequence.ts     // 结果 → frame 更新（经验影响下次判断）
  index.ts           // 组装
```

**`decide.ts` 是唯一调用模型做行为决策的地方。** 它接收 frame，返回 Intent，不做任何规则预处理。

### 5.2 表达主权接口

```ts
// 模型可以自由选择：多个气泡、各自延迟、各自媒体、各自引用目标
// 宿主只校验：单条长度上限、媒体是否存在、是否超出预算
type ExpressionPlan = {
  bubbles: Bubble[];
  silent?: { reason: string };   // 这是合法结果，不是失败
};
```

删除 `segmenter` 的规则配置（长度镜像、标点习惯、emoji 概率）——这些由模型在 `bubbles` 里直接体现。

### 5.3 经验影响判断（不是新规则）

```
consequence.ts：
  - 被无视 / 被引用 / 被怼 / 被夸 / 被纠正 → 写入 outcome 事件
  - outcome 汇总成 frame 的"最近互动质感"字段
  - 该字段进入下一次 decide 的上下文
  - 不产生新规则，不写硬编码阈值
```

这是 P6 的落地：让 bot 因为"上次说这个没人理"而下次少说，而不是因为 `engagement.ts` 算出了 0.12。

### 5.4 自我进程（真实的自发行为）

现有 `cognitive-continuity.ts` + `cognitive-process-runtime.ts` 已有骨架但进程种类有限。扩展为：

```
observer      → 观察群内动向，形成兴趣候选
curiosity     → 主动探索（读 RSS、看历史、想问题）
social_mind   → 维护关系模型
craft         → 做东西（画图、写代码、查资料）
care          → 关心特定的人/话题
skeptic       → 自我质疑、发现矛盾
```

每个进程只有 `wake → read frame → propose → checkpoint`，**不直接发送**。它的 propose 进入正常决策回路，与 telegram observation 平等竞争。

---

## 6. 分阶段路线

### Phase 0：止血 + 清场（低风险，立即做）

1. **修 Bug A**（已由子 agent 修复，待你确认）：`pipeline.ts:377` 增加 `!isSlashCommandEntry` 守卫，使 NyatBot 自有白名单命令不被 floor 提前 silence。
2. **修 Bug B**：把 `isEdit` 并入 Meta 入口，消除双路径。
3. 删除 §4.1 的死模块 + §4.6 的僵尸 flag。
4. 删除 `DIRECT_INTERACTION_RULES` 里的死规则名。

**验收**：`/cards`、`/game`、`/wish`、`/checkin` 在群里正常响应；其他 bot 的命令（`/play` `/music` 等）**仍然不被抢答**（回归测试必须覆盖这一点）；`typecheck`/`lint`/全量测试绿。

### Phase 1.5：能力迁移（缺失的前置，必须先于删除）

**这是初稿遗漏、也是"能否删 legacy"的真正前置条件。**

1. **命令面**：把 `judge/rules.ts:27-43` 的 13 个白名单命令 + `intercepts.ts:73-150` 的 `dispatchCommand` 搬进 Meta（`meta/ingress-intercepts.ts` 现只覆盖 6 个分支），并给 `metaNeedsLegacyPipeline` 加回归测试。
2. **投递能力**：把 humanizer / segmenter / quote 抑制 / 贴纸冷却 / 投票上限 / react 白名单搬成 host-api 可调用的 service，**或**明确接受"Meta 侧不提供这些"。
   - 注意与本计划 §5.2 的一致性：segmenter 与人味层**不应**原样搬迁——按 Phase 2 的设计，分段与节奏应由模型决定。这里的迁移目标是把"能力"变成"模型可调用的接口"，而不是搬规则表。
3. **数据注入**：签到/统计/roster/画像/黑话/往事——决定搬进 CodeAct 还是废弃。
4. 三项全绿且生产跑通一轮后，才可进入 Phase 1 删除判断层。

**验收**：`metaNeedsLegacyPipeline` 的返回率为 0（除 `/checkin` `/stats` 类数据注入需求外）；被搬走的命令在 Meta 路径下功能与 legacy 一致。

### Phase 1：单一决策点（核心，最大改动）

1. 新建 `src/core-loop/`，实现 `observation`/`frame`/`decide`/`validate`/`express`/`receipt`。
2. 把 Meta 的 heart 调用改为调用 `core-loop.decide()`。
3. **删除** §4.2 的规则层（规则 → 事实迁移）。
4. **删除** §4.3 的重复 gate 调用。
5. 保留旧路径作 fallback，用 flag `NYATOS_CORE_LOOP_ENABLED` 灰度。

验收：同一消息只经过一次决策；`grep -r "shouldReply\|shouldSpeak"` 只剩 core-loop 内一处；行为对比报告（新旧回复分布）；延迟不恶化。

### Phase 2：表达主权

1. `decide()` 返回完整 `ExpressionPlan`（多气泡 + 延迟 + 媒体）。
2. `express.ts` 按模型指定执行，不再走 `segmenter` 规则。
3. 删除 `stickerPolicy` 冷却、`humanizer` 概率、`delay` 魔法数字。
4. 保留最小宿主约束：单条 4096 字符、媒体文件存在性、预算。

验收：模型能自主决定"发 3 条带停顿"和"配一张图解释"；`grep -rn "MAGIC_DELAY\|stickerCooldown"` 归零。

### Phase 3：prompt 开放化

1. 删除 `behavior-style.md`，重写 `guardrails.md`（只留现实约束）。
2. 压缩 `subagent/executor.ts` 的行为准则。
3. 统一 ~20 处 prompt 组装点到 `core-loop` 的 frame 渲染。

验收：system prompt 总量下降 >40%；prompt 里不再出现"什么时候该安静"类规则；行为质量人工评估不下降。

### Phase 4：经验驱动

1. `consequence.ts` 落地：outcome → frame 质感字段。
2. 验证"上次被无视 → 下次更少说话"可观测。

验收：replay 显示行为随经验变化，且变化可追溯到具体 outcome 事件。

### Phase 5：自我进程扩展

1. 扩展 §5.4 的自我进程种类。
2. 进程 propose 与 telegram observation 平等竞争。

验收：bot 能自发因为"对这个话题感兴趣"而观察/发言，且能解释原因。

### Phase 6：多 agent 处置（需你决定）

A/B 验证 `multiagent/` 是否真比单次强模型调用更好。若不显著 → 删除 13 个模块。

---

## 7. 风险与回滚

| 风险 | 缓解 |
|---|---|
| 模型判断力不足导致行为退化（该说的不说 / 乱说） | Phase 1 灰度：先并行 shadow 对比，不直接切换 |
| 删除规则后缺乏保护 | 宿主现实层保留全部硬约束（权限/预算/幂等）；只删行为规则 |
| prompt 开放后风格崩坏 | persona + tone 完整保留；Phase 3 独立灰度 |
| 多 agent 删除影响质量 | Phase 6 独立 A/B，不与其他阶段混合 |
| 大改动破坏生产 | 每阶段独立 flag + 灰度列表；事件表不删不重写；随时回退上一构建 |

**回滚原则**：所有阶段用 `NYATOS_*` flag 独立控制，默认 OFF，灰度可收缩。任何阶段失败 → 关 flag 回旧路径，不复写历史数据。

---

## 8. 验收标准（总）

1. 决策点数量：从 19（13+6）降到 **1**。
2. prompt 组装点：从 ~20 降到 **1**（core-loop 渲染 frame）。
3. `system prompt` 中行为规则条数：**0**（只剩 persona/tone/工具说明）。
4. 规则引擎文件：`rules.ts`/`engagement.ts`/`silence.ts`/`path-heuristic.ts`/`path-patterns.ts`/`instruction.ts` 的行为判定部分 **全部删除**。
5. 表达主权：模型可自主决定分段数、延迟、媒体；`segmenter` 规则配置删除。
6. 经验闭环：replay 可证明 outcome 改变了下一次行为。
7. 无用户可见回归：**NyatBot 自有**命令（`/cards` `/game` `/wish` `/checkin`…）、回复、媒体全部正常；**其他 bot 的命令仍不被抢答**；延迟不恶化。
8. `typecheck`、`lint`、全量 Vitest 保持绿。

---

## 9. 四项决议（2026-09-17 已完成）

1. **Bug A 修复：保留，并收敛为精确版。**
   子 agent 的粗放版放行**所有**斜杠命令，会让 `/play@其他bot` 掉到 L0 之后多绕一轮。已改为只放行"无 @ 后缀或明确 @ 本 bot"（`pipeline.ts` 的 `isOwnSlashCommand`）。
   安全依据：L0 的 `getCommandName` 只对"指向本 bot 且白名单内"返回 REPLY，其余 `unknown_command` → 0ms IGNORE。
   新增 `tests/unit/pipeline/floor-command-guard.test.ts`，含"其他 bot 命令仍不被抢答"回归。

2. **Phase 1.5 取舍：往"模型自产分段与节奏"方向走。**
   本轮已先落地表达主权（见第 4 项）；humanizer/segmenter 的搬迁留到 Phase 1.5，按"能力变成模型可调用接口"而非"搬规则表"处理。

3. **`multiagent/`：已 A/B 并关闭。**
   `scripts/ab-multiagent.ts`（live-only，需 `NYAT_LIVE_ENV`），真实群消息 n=30 盲评：
   - 偏好 19:11 偏向编排器，但**双尾二项 p≈0.20，不显著**
   - 成本确凿：LLM 调用 ×4.3、延迟 ×4.0
   - 质量缺陷：**3/30 把专家内部术语泄漏进正文**
   → `MULTI_AGENT_ENABLED=false`。flag 与子开关保留，便于将来用更强模型重测。
   **注意**：该 A/B 首版因投票 `max_tokens` 太小（模型只回 thinking 无 text）得到"全 tie"；修正后才有真实票。详见 §12 教训。

4. **媒体完全交给模型：已落地。**
   - `parser.ts` 新增 `media`（kind/ref/options/emoji/position）、`delayMs`、`typingGhost`；非法 media 整块丢弃，越界 delay 忽略而非截断。
   - `deliver.ts` 三处主权归还：`typingGhost` 不再是宿主 3% 骰子丢消息（只有模型能声明）；`delayMs` 优先于 RNG 人类分布；贴纸位置由 `media.position` 决定。
   - 契约与 prompt 同步（`reply-schema.json` / `task/reply.md`），删除"每 3-5 条回复一次"等频率配额。
   - **保留的宿主约束都是"现实"而非"行为"**：Telegram 反应 emoji 白名单（平台限制）、intent→素材解析、体积与权限校验。

验证：typecheck/lint 干净；全量 **369 files / 2891 tests** 通过；build 后重启，消息正常流转，无新错误。

---

## 10. 附：本计划与旧计划的关系

- `2026-09-16-nyatbot-latest-agency.md`：记录了 SocialAct/continuity/circuit 的实现，**继续有效**（它们是本计划的观测层基础设施）。
- `2026-09-17-nyatos-kernel-refactor.md`：kernel 的 trigger/frame/action/outcome 契约**被本计划继承**并成为 core-loop 的骨架。
- `2026-09-17-nyatos-runtime-rearchitecture.md`：`CognitiveTurnRuntime` + `cognitive-recovery` **保留**，作为宿主现实层的执行与恢复机制。
- **本计划的区别**：前几份都在"现有框架里加正确的模块"；本计划**删掉框架本身**（规则层、决策分裂、prompt 牢笼），让模型接管主权。

---

## 12. 教训：A/B 工具的解析失败必须显式暴露

`scripts/ab-multiagent.ts` 第一版把模型投票读成"全 tie"，如果照收就会得出**与事实相反**的结论（"编排器无收益"其实是因为一票都没读到）。

原因：`step-3.7-flash` 走 Claude 格式时会先输出 `type:'thinking'` 块。首版解析只取 `type:'text'`，且投票 `max_tokens` 只有 40 —— 实测该端点需要约 800 tokens 才能先思考完再吐出正文。

修正后：
- `extractText()` 显式跳过 thinking，并回报 `sawOnlyThinking`；
- summary 区分 `votesReadable` / `votesUnreadable`，读不到时 verdict 直接给 `INCONCLUSIVE — no readable votes; cost data only`；
- 投票预算提高到 800 并写明"不要调小"及原因。

**通用规则：任何 A/B 或评测脚本，解析失败必须与"真实平局"区分开。** 否则工具会平静地给出反向结论。
