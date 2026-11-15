# Phase 4 删除计划：先审计，再删

> 2026-09-18。原则：**每一处删除都要先证明它的调用方和风险**，
> 不做"看起来该删就删"。上一阶段（Phase 1）已经证明
> "模块存在 ≠ 模块在运行"，这一阶段要证明"模块在运行 ≠ 模块必要"。

## 一、judge 的分层审计

### 1.1 `evaluateRules`（规则表，9 条）—— 逐条判定

| 规则 | 性质 | 生产命中 | 处置 |
|---|---|---|---|
| `bot_message` | **事实**：这条是别的 bot 发的 | — | **保留**（是事实，不是判断） |
| `bot_fatigue`（≥8 轮） | **判断**：聊太久了 | 0 | 删（NyatOS 有 Self.history） |
| `reply_to_self` | **事实**：回复了 bot | 3 | **保留** |
| `sticker_dislike`（正则） | **判断**：嫌弃贴纸 | 0 | 删（模型读得懂） |
| `whitelisted_command` | **事实**：是白名单命令 | — | **保留** |
| `unknown_command` | **事实**：是命令但不在白名单 | — | **保留** |
| `mention_self` | **事实**：@ 了 bot | 12 | **保留** |
| `forwarded` | **事实**：是转发 | — | **保留** |
| `private_chat` | **事实**：私聊 | — | **保留** |
| `recent_reply`（近 2 条内有 bot） | **判断**：刚说过话 | — | 删（NyatOS 的间隔维度已覆盖） |
| `at_others` | **判断**：话题指向别人 | — | 删（模型读得懂上下文） |

**关键区分**：`mention_self` / `reply_to_self` / `private_chat` / 命令判定
是**事实提取**（"这条消息是否指向 bot"），不是**行为判断**（"该不该回"）。
事实提取必须保留——否则连"有人在叫我"都要模型猜。

**结论：删 4 条判断类规则，保留 6 条事实类。**

### 1.2 `judge()` L1/L2 —— 实际是故障回退

审计发现：`judge()` 在生产**只有一个调用点**，是 heart 的 LLM 失败回退
（`heart.ts:280`，当 defer 预算耗尽时）。

实测命中：**1 次**（`Heart infra failure, defer budget exhausted → legacy judge`）。

**处置**：不删，但降级为**故障回退专用**。理由：删了它，heart 的 LLM 挂掉时
就没有兜底裁决。这是可靠性设施，不是内容判断层。

### 1.3 `judge/rules.ts` 的外部导出

只有 `isMentioningSelf` 被外部使用（`floor/addressee.ts`、`pipeline.ts`）。
**它必须保留**——它回答"这条消息有没有 @ bot"，是事实。

## 二、heart 的审计

heart 做三件事，只有一件该走：

| 职责 | 处置 | 依据 |
|---|---|---|
| 内容判断（该不该说） | → NyatOS | Phase 2 已证明单决策点能做这件事 |
| 节奏控制（cooldown/engagement/refractory） | **保留** | Phase 2.3 证明模型自己管不住 |
| 产出 `judgeResult` 形状 | **保留契约** | 12 个文件依赖它；替换契约是独立工程 |

**结论：heart 的 LLM 调用是 Phase 4 的替换目标，但节奏层与契约层保留。**

## 三、reply 的审计

| 职责 | 处置 | 依据 |
|---|---|---|
| 5 层 prompt 组装（8,665 tokens） | → Frame | Phase 4 主目标 |
| 生成文本 | → NyatOS Action | 与 prompt 一起换 |
| segmenter 规则配置 | 删 | 分段该由模型决定 |
| humanizer 的 RNG | 已部分删（Phase 0 前） | — |
| **发送 + 回执** | **保留** | 这是身体，不能删 |

## 四、gate 的审计（已完成，见 timing-gate-audit）

保留物理调度（冷却/攒批/wait/时段），删除 LLM 内容判断。

## 四补、⚠️ 实测推翻了本计划的三处假设（2026-09-18）

在动手删之前，我用**真实生产消息回放** `l0Rule` 做了测量（103 条样本），
结果与本文档前面写的"0 命中"**不一致**：

### 假设 1 被推翻：at_others 不是 0 命中
```
样本总数: 103 | 落到心流: 99
规则命中分布:
     2  at_others
     2  forwarded
```
**`at_others` 真的会触发（2/103）**。而且我用单决策点测了同类场景：
"@xiaolin 你那个脚本能发我吗" → **模型说 speak（想凑热闹接话）**。
即使把"这条是问 @xiaolin 的，不是问你"作为事实写进 Frame，**它仍然说 speak**。

→ **`at_others` 不能删。** 它挡住的正是模型想抢话的场景。

### 假设 2 被推翻：我之前的"0 命中"是测量错误
我最初用 `grep rule=` 统计日志，只看到 `mention_self`(12) 和 `reply_to_self`(3)，
就写下"其他规则 0 命中"。**那是错的**——`rule` 字段只在 sleep 路径被日志记录，
主路径根本不记。**用日志量规则命中率是不可靠的**，必须回放真实数据。

### 假设 3：heart 已经降级了部分规则
`heart.ts:71-77` 已经在心流路径上把 `recent_reply` / `hot_chat` 降级为 `null`
（注释明确写了自激事故）。所以这两条在 Meta 主路径上**本来就不生效**，
删它们只影响 legacy pipeline。

## 四补二、核对中发现的真实缺口（已修）

### Frame 没有告诉模型"你是谁"
测 `@hunhebi_bot 在吗` 时，模型回答："这条是@nyatbot的，和身为啾咪囝的我无关，不用接"
→ **它认不出自己的用户名**。Frame 只渲染了"你"代表人称，却没给身份。

**已修**：Frame 新增 `identity`（uid/username/displayName），渲染成
`[你是谁] 你是 啾咪囝 / @hunhebi_bot。群里 @ 这两个名字就是在叫你。`
修复后：`@hunhebi_bot 在吗` → speak ✓，`啾咪囝 帮我看看` → speak ✓

### 顺带
新增 `addressedToOthers` 事实（`[这条是说给谁的] 这条消息是问 @xiaolin 的，不是问你。`）。
虽然**没能说服模型收手**（它仍然想接话），但它是一个正确的宿主事实，
保留在 Frame 里没有坏处——而且它让 `at_others` 的存在理由更清楚。

## 五、删除顺序（按风险从低到高）—— 已按实测修正

### 批次 1（修正后）：只剩 2 条，且都需要先验证

原计划删 4 条。实测后**只剩 2 条可删**：

| 规则 | 原计划 | 修正后 | 理由 |
|---|---|---|---|
| `bot_fatigue`（≥8 轮） | 删 | **待验证** | 是循环断路器，删前要证明模型会自己收手 |
| `sticker_dislike`（正则） | 删 | **可删** | 只被 rules.ts 内部用，模型读得懂嫌弃语气 |
| `recent_reply` | 删 | **保留** | heart 已降级；legacy 路径仍需要它防自激 |
| `at_others` | 删 | **❌ 不能删** | 实测 2/103 触发；模型会抢话，且告知无效 |

**结论：原计划的"批次 1 零风险"是不成立的。** 我差点删掉一个真正在起作用的规则。

### 批次 2：低风险（有调用方但可安全替换）
```
gate.ts 的 LLM 调用 + timing-gate.md
  → 需要先确认 gate 的 LLM 分支在 heart 路径上不执行（heart 已设 gateBypass）
```

### 批次 3：中风险（契约替换）
```
reply 的 5 层 prompt → Frame
heart 的内容判断 → NyatOS
  → 需要 12 个 judgeResult 依赖文件一起改
```

### 批次 4：高风险（需要 NyatOS 先能发送）
```
pipeline 编排替换
```

## 六、我不打算删的（并说明理由）

| 不删 | 理由 |
|---|---|
| `judge()` 函数本身 | heart 的故障兜底，实测触发过 1 次 |
| `isMentioningSelf` 等事实提取 | 事实，不是判断 |
| `heart` 的节奏层 | Phase 2.3 证明模型管不住 |
| `reply` 的发送/回执 | 身体 |
| `gate` 的物理调度 | 见 timing-gate-audit |
| `judgeResult` 形状 | 12 个依赖文件；替换是独立工程 |


---

## 七、`sticker_dislike` 核对结果：不能删（第三次推翻）

原计划：删掉 `sticker_dislike` 正则，理由"模型读得懂嫌弃语气"。

**核对后发现三个问题：**

### 1. 它有真实副作用，不是回复规则

`intercepts.ts:211-224` 消费这个标签，触发一条**学习回路**：
```
lookupSentSticker(chatId, replyTo.messageId)   // 找到 bot 刚发的那张贴纸
  → recordStickerDislike(fileUniqueId, chatId, uid)  // 写 sticker_ratings = -1
  → 衰减 user_score（以后少给这个人发这张）
  → 回一句 "好的，这个贴纸不会再出现了喵~"
```

这不是"该不该回"，是**记住用户不喜欢哪张贴纸**。删掉标签 = 删掉这条学习回路。

### 2. 它不是死的，是罕见的

我先前说"0 命中"——但生产里 `sticker_sent_log` 有 **3,044 行**，bot 确实在发贴纸。
触发条件是"**回复** bot 的贴纸消息 + 说出嫌弃的话"，所以命中率天然低。

### 3. 模型确实读得懂，但它只会"回一句"，不会"记下来"

实测（用真实 Frame 喂单决策点）：

| 用户说 | 正则 | 模型判断 |
|---|---|---|
| 别发了 | 漏 | speak「刚说别发，道歉回应比较合适」 |
| 能不能换个表情 | 漏 | speak「需要友好回应对方」 |
| 这贴纸好丑 | 中 | speak「需要回应互动」 |

**模型在三种情况下都理解了用户不满**（甚至比正则更准，正则漏了两种自然说法），
但它给出的是"**回一句**"，而现有代码要的是"**记进数据库**"。

### 结论

**`sticker_dislike` 标签必须保留**，因为它是学习回路的触发器。

但这里有一个**真实的改进机会**（不是我原计划的删除）：
正则漏掉了"别发了"/"能不能换个表情"这类自然说法。
**正确做法是把触发从正则换成模型**——让单决策点输出一个
`recordDislike` 动作，而不是靠关键词匹配。这是 Phase 4 的**新增项**，
不是删除项。

### 又一次教训
**我第四次差点基于"看起来该删"下决定。** 前三次是 at_others / 日志测量 / Frame 身份，
这次是 sticker_dislike。共同点：**只看了规则本身，没看谁消费它的输出。**


---

## 八、`bot_fatigue` 核对结果：保留（第四类：断路器）

原计划：删（0 命中）。
实测：**确实 0 命中**——但原因是**前提前不存在**，不是规则无用。

### 取证
```
bot-to-bot 消息（2000 条样本里）：0
日志里唯一一条 bot_message：是我自己的 core shadow compare 日志
```

### 它是唯一的保护
```
grep bot_fatigue|ourRecentReplies src/  →  只有 rules.ts 自己
```

`bot_fatigue` 是**唯一**阻止 bot 间无限对话的机制。当两个 bot 互相 @ 时：
```
bot A @ bot B → bot B 回 → bot A 再回 → ...
```
没有它，这个循环**没有其他东西会停住**（cooldown 只针对人类消息的节奏）。

### 判断
**这与 cooldown 是同一类东西：物理断路器，不是内容判断。**
- 0 命中 ≠ 可以删；0 命中 = 当前没有触发条件
- 一旦有第二个 bot 进群互动，它就是唯一的保险

**保留。** 但和 `at_others` 一样，它揭示了一个真实的改进方向：
断路器应该在**触发时告诉模型**"你已经和这个 bot 来回 8 轮了"，
而不是静默丢弃——这样模型能自己选择收手。

## 九、Phase 4 净结果：原计划要删 4 条，实际删 0 条

| 规则 | 原计划 | 核对后 | 决定性证据 |
|---|---|---|---|
| `at_others` | 删 | ❌ **不能删** | 实测 2/103 触发；模型想抢话，告知事实后仍想抢 |
| `sticker_dislike` | 删 | ❌ **不能删** | 是学习回路触发器（写 sticker_ratings），不是回复规则 |
| `recent_reply` | 删 | ⚠️ 保留 | heart 已降级；legacy 路径仍需防自激 |
| `bot_fatigue` | 删 | ⚠️ 保留 | 唯一的 bot 循环断路器；0 命中因前提前不存在 |

**"删内容判断层"这个方向本身是对的，但我把"内容判断"和"物理保护"混在了一起。**
逐条核对后，这 4 条**全部**属于后者：

| 真正的分类 | 例子 | 处置 |
|---|---|---|
| **内容判断**（该不该说） | judge L1/L2、gate 的 LLM、heart 的内容判断 | → NyatOS（Phase 4 主目标） |
| **事实提取**（谁在跟谁说话） | mention_self、reply_to_self、at_others | **保留** |
| **物理保护**（防失控） | cooldown、bot_fatigue、recent_reply、额度 | **保留**，但改成模型可见 |
| **副作用触发**（学习回路） | sticker_dislike | **保留**，但改成模型触发 |

### 修正后的 Phase 4 任务
删除目标从"4 条规则"改为：
1. **judge 的 L1/L2 LLM 调用**（纯内容判断）
2. **gate 的 LLM 判断 + timing-gate.md**
3. **heart 的内容判断部分**
4. **reply 的 5 层 prompt**（8,665 tokens → Frame）

外加 3 个**改进项**（不是删除）：
- `at_others` 的告知方式（事实已在 Frame，模型仍不听 → 需要更强的表达）
- `sticker_dislike` 从正则改为模型动作
- `bot_fatigue` 触发时告知模型而非静默丢弃

---

## 十、死代码审计（2026-09-19）

### 方法（踩过三次坑才找到可靠的）
1. ❌ 正则扫 import 路径 → 假阳性 445/446（路径写法太多）
2. ❌ TypeScript compiler 建图 → 漏了 `src/index.ts` 作为入口、漏了 scripts/ 调用
3. ✅ **`grep -c 'src/path/file.ts' dist/index.js`** —— 构建产物里有没有它
   - 对照组验证：`heart.ts`(1)、`heart-adapter.ts`(2)、`unified-tick.ts`(2)、`worker.ts`(2) 都在
   - 这问的是"**它是否在运行的程序里**"，比任何静态分析都直接

### 删掉的（8 个文件 / 431 行）
| 文件 | 行数 | 依据 |
|---|---|---|
| `src/core/index.ts` | 21 | 零 import；自己的注释写"Phase 1+ 从这里 import；主路径暂不接任何 core"——**Phase 1 从未发生** |
| `src/cache/tiered.ts` | 41 | bundle 零出现，仅测试引用 |
| `src/ai/router.ts` | 16 | 之前的 2 处"引用"是同名文件（command-router / multiagent-router） |
| `src/shared/soft-truncate.ts` | 56 | 零生产引用（测试混在 attention-hardening 里，已摘掉该块） |
| `src/pipeline/reply/reply-mode.ts` | 65 | bundle 零出现 |
| `src/tracking/chat-pressure.ts` | 86 | bundle 零出现 |
| `src/eval/spot-the-bot.ts` | 81 | 整个 harness 已不存在 |
| `src/knowledge/sticker/capture.ts` | 65 | bundle 零出现 |

### ⚠️ 删错了又恢复的（2 个）
`shared/soft-truncate.ts` 和 `pipeline/reward/reward-model.ts` 我删掉后测试失败，
**恢复了 `reward-model`**（它有明确意图注释：主动搭话意愿闸，"取代扁平概率"——
属**未接线**而非废弃）。

`soft-truncate` 恢复后确认**确实零生产引用**，最终删除（只摘掉混在
`attention-hardening.test.ts` 里的那一段，保留同文件里活的 `classifyAttentionLayer` 测试）。

**这个过程证明了：静态分析必须配合跑测试。** 我的 bundle 检查把
`soft-truncate` 判成死的（对的），但同一批里 `reward-model` 也是"零引用"，
靠**意图**而非引用数才区分出该保留。

### 发现但**没有删**的（未接线的功能，需要决策）
| 文件 | 状态 |
|---|---|
| `src/core/beliefs/contradict.ts` | `contradicted` 状态在 4 处被**读**，但零处**写**。有 4 个通过的测试 |
| `src/core/skills/prune.ts` | `docs/core-v2.md:53` 明确列为 Phase 4 功能，但零调用方。表是空的所以暂时无害 |
| `src/agent/agency-control-adapters.ts` | Core v2 架构的一部分，`agency-runtime` 在 bundle 里但适配器不在 |
| `src/pipeline/reward/reward-model.ts` | 主动搭话意愿闸，注释说"取代扁平概率" |

**这四个不是死代码，是"建好了没接线"——和 Phase 1 发现的 `world_change` 同类。
删它们会破坏计划中的功能，应该由人决定是接上还是废弃。**

### 教训
**"看起来死"经常是"我的检测方法没覆盖到"。** 这一轮我的检测错了三次：
正则假阳性 445 个、编译器漏入口、bundle 检查漏动态 import。
**唯一可靠的做法是：静态判定 → 删除 → 跑全量测试 → 错了就恢复。**
