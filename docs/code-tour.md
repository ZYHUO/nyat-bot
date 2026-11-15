# Code tour — 六步看懂一条消息怎么走

仓库有 16 万行 TypeScript。新人第一个问题不是"这代码怎么样"，而是**"我该从哪读起"**。
这份给你一条线：按顺序读六个文件，读完你就知道 NyatBot 和其他群聊 bot 的分歧在哪。

每一步都标了**它回答的问题**和**读的时候重点看什么**。六步走完大约一小时。

---

## 0. 先跑起来看行为（五分钟，不要读代码）

```bash
npm run demo
```

不需要 bot token、不需要 API key。它把一个写好的群聊剧本喂给仓库里的真代码，
你能看到：分层判定、爆发信封拦下一次"未发送"、回复分 3 句发出去、句间打字间隔。
跑完再读代码，你就知道每段机制对应哪个可观察行为。

---

## 1. `src/pipeline/pipeline.ts` — 一条消息的骨架（655 行）

**回答的问题**：消息进来之后，先经过什么、后经过什么？

这是整个系统的编排器。从上往下读 `processPipeline`，你会看到一串阶段：

```
ingest → dedupe/rate-limit → classify（分层）→ judge → reply 或 silence → deliver
```

**重点看**：
- 每个阶段的边界在哪，哪一段可以提前 `return`（很多行为是通过"在这里就不走了"实现的）
- `heartResult.shouldReturn === true` 是什么意思（副作用已做完，直接收尾）
- 哪些阶段是 flag 门控的（`docs/flag-census.md` 里有全部 488 个 key 的口径）

**别在这纠结细节**，你要的是一张地图。

---

## 2. `src/pipeline/heart/decision.ts` — 它凭什么决定不说话（399 行）

**回答的问题**：别的 bot 是"来消息就回"，NyatBot 怎么决定**不**回？

这是整套东西的核心分歧点。`heartDecision()` 调一次 LLM，让它以**第一人称**判断：

```json
{"act": "reply | react | wait | pass", "emoji": "🤣", "why": "笑死"}
```

四种出口，成本递增：

| act | 做什么 | 对回复率的贡献 |
|---|---|---|
| `react` | `setMessageReaction`，不产生气泡 | 0 |
| `wait` | 等几秒再回访，等完一口气回整件事 | 0（推迟） |
| `pass` | 这条不接，但你还在场 | 0 |
| `reply` | 真的说话 | 1 |

**重点看**：
- `parseHeart()` 怎么处理模型吐脏 JSON（小模型吐单引号/Python dict 不算罕见）
- 四个出口分别怎么落到 `JudgeResult`（下游 mute/intercept/telemetry 要沿用同一个形状）
- fail-closed 的几条路径：prompt 读不到、LLM 超时、解析失败 → **一律 pass**。静默吞回复是它的缺省姿态。

**配套的 prompt** 在 `prompts/task/heart.md`。那个 Markdown 就是产品行为的主要控制面——
它没有类型检查，`tests/unit/pipeline/heart-prompt-balance.test.ts` 用断言锁住它的结构。

---

## 3. `src/pipeline/heart/heart.ts` — 四个出口各自怎么落地（426 行）

**回答的问题**：心流说了算之后，host 真的去做什么？

`runHeartBranch()` 把第 2 步的裁决变成动作。重点看 react 和 wait 两支：

- **react**：`reactToMessage()` → 记 `recordDecision('react')` → `shouldReturn: true`。
  表情由模型选，host 只用 `normalizeReactionEmoji()` 过白名单（Telegram 只接受固定集合，
  白名单外的一律拒——发错情绪的 emoji 比不发更糟）。
- **wait**：写锚点 + `transitionToWait()`，等回访。回访链路在
  `src/pipeline/timing/chat-runtime.ts`。

---

## 4. `src/pipeline/turn/actor.ts` — 三条消息怎么算一句（780 行）

**回答的问题**：群里有人连发三条，bot 为什么不当成三次提问？

`Turn Actor` 是"参与感"的工程化：爆发合并成一次思考、生成中途被打断会**重新规划**而不是硬发完、
"等他们说完"真的会等。

**重点看**：
- burst 怎么合（`quiet-period.ts` 的判据）
- 中断后的 replan 路径
- `isTurnActorChat()` 什么时候为假（不是所有群都走这条）

---

## 5. `src/pipeline/context/manager.ts` — 它拿什么当上下文（488 行）

**回答的问题**：模型看到的"群聊上下文"到底是什么形状？

`getRecent()` / 四路检索（static/delta/ephemeral/volatile）+ `slimContextForAI()` 压缩。
这套东西决定了模型对"现在群里在聊什么"的认知边界。

**重点看**：
- `slimContextForAI` 为什么存在（prompt 长度 = 延迟 = 钱）
- context 里哪些是**事实**、哪些是**判词**（前者能信，后者只是模型的自我叙述）

---

## 6. `src/ai/labels.ts` — 模型是怎么被选中的（198 行）

**回答的问题**：为什么同一次对话里，判断和回复可能用不同模型？

`USAGE_PROFILES` 给每种用途（reply / judge / summarize / vision / deep_think）各配一条链，
`smart-group.ts` 从健康/延迟池子里自动选，带熔断、对冲请求、跨域名兜底。

**重点看**：
- `requiresDeterministic` 为什么排除 `temperature` 被锁死的 label
- 跨账号兜底为什么判据是 **URL host** 而不是 endpoint+key
  （censorship 和账号级限流都是按域名决策的）

---

## 想改某个行为，该读哪里

| 我想改… | 读这里 |
|---|---|
| 它话太多 / 太少 | `prompts/task/heart.md` + `docs/voice-tuning.md` |
| 它老是重复同一句 | `src/meta/answered.ts`（回过了几次的事实怎么递过去） |
| 它答非所问 | `src/pipeline/heart/decision.ts` 的上下文段 + `src/pipeline/context/manager.ts` |
| 它说话不像人 | `src/pipeline/reply/segmenter.ts` + `humanizer.ts` |
| 加一个新模型 | `docs/skills.md` 之外的 provider 部分——先讨论，池子有发送预算和顺序 |
| 加一个新工具给 bot | `docs/skills.md`（一个 JSON 文件的事） |
| 某个 flag 到底管什么 | `docs/flag-census.md`（488 个 key 的完整口径） |

---

## 三条不成文规矩

1. **文档说它会跑，它就得会跑。** 这个仓库做过一整轮审计，起因是七件"宣传了但没实现"的事。
   `tests/unit/pipeline/prompt-files.test.ts` 和 `tests/unit/pipeline/skill-doc-examples.test.ts`
   就是在守这条——文档里的例子会被抠出来过真 schema。
2. **量了再改。** `npm run measure:voice` 给你回复率/心流四态/重复率/撞名守卫四个数。
   没有数字的行为改动不要提。
3. **宿主持有身体状态，模型只能读。** 想加一条"不许怎样"的规则时，先问：
   它是 host 侧的一个数（对），还是写进模型判断里的一句 prompt（也常见，但要说明为什么）。
