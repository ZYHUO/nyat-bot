# Known issues — 这个项目现在**还没解决**的事

一张表。`voice-tuning.md` 是流水账（1826 行），这张是结论。
每条都标了**怎么验**，方便下一个人（或下croft轮）复查。

## 有生产证据的（已修且在真拦）

| 问题 | 修法 | 基线 | 怎么验 |
|---|---|---|---|
| 同一锚点被回多次 | 发送前读 answered 账本（round 89/90） | 修复前 343 条带锚 / 24 组重复（7.0%） | `npm run gate:evidence`（round 131 首次拦到 2 次，明细带 anchor/recent/文本） |

**别用"数成功发送了几条"来判断它有没有拦**——round 123 就那么误判过：
被闸拦掉的尝试 msg 名不同，不进 `host sendText` 统计。闸自己的日志是唯一观测点。

## 修了，效果量到但样本小

| 问题 | 修法 | 效果 | 怎么验 |
|---|---|---|---|
| 403 并发限流循环被打 | 账号级限流冷却 60s → 300s（round 83） | 67 次/h → 10 次/h（12 分钟样本） | `grep 'concurrent request limit' logs/app.log` 按分钟数 |

## 有意为之，但值得知道

| 现象 | 为什么 | 备注 |
|---|---|---|
| `verified_use_count` 全 0 | `task-evidence.ts:78-80`：`'verified'` 只在契约来自 **caller** 时产出，模型自评不算 | 群聊没有 caller 契约 → 恒 unverified。**是设计**（round 97/98 修正） |
| 反广告空转 | 0 个群授权（`xxb:trench:antiad:on:*` 空），49 个指纹在采 | 没授权不该用 = 正确行为；但采集在花 Redis 写（round 109） |
| dist 里中文是 `\uXXXX` | esbuild 行为 | grep 构建产物里的中文要用转义形式，否则误判"代码没进去"（round 63/67） |

## 已诊断、待你拍板（不改语义）：LLM 短链被限流拖死（round 147-150）

**现象**：`All labels exhausted` 从 09-19 的 138 次/天 跳到 09-20 的 2700 次/天，
此后维持高位。报错方前两位是**心流本身**（2699，全窗口）
和**影子决策**（1654，今天 259）。后台批任务（Vision 583 / deep-reflection 589 /
Knowledge 220）在同一个池子里互相抢 label，把对方拖进冷却。

**根因**：round 83 给 403/并发限流加了 5 分钟锁冷却。它止住了一天 570 次的死循环，
但一个 label 被冷却时，链上候选可能**540 秒 while 全部冷却** → 整批全灭。
链越短（reflection 只有 1 个 label）越易中招。

**不能简单把冷却改回去——那会回到 403 死循环。

### round 197：**那个 300s 冷却没在阻止同次发**

用闸自己的判据量（不是"一天报多少次"，那个数字已经没意义）：
**同一个 model 连续两次被 concurrent limit 打到的间隔**。

\`\`\`bash
# 口径：全日志，Label failed, trying next 且 err 含 concurrent request limit，
# 按 Circuit breaker tripped 日志里的 label->model 映射分组。
\`\`\`

结果（三天）：

| 日期 | 同 model 相邻两次 | 其中 ≤300s | 占比 |
|---|---|---|---|
| 09-21 | 13 | 12 | 92% |
| 09-22 | 685 | 597 | 87% |
| 09-23 | 576 | 502 | 87% |

**87% 的间隔在冷却期以内**，而且有大量 0-1 秒的（同一秒被打两次）。

也就是说：`setCooldown(model, 300)` 写了，`isCoolingDown(model)` 也读了，
但**540 秒里同一个 model 还是被试了很多次**。

**假设**（未验证，写在这里为了下一轮能验）：
check-then-launch 不是原子的。并发的多个 `callWithFallback`
（不同 chat / 不同任务 / 不同 usage）在同一刻读到
"没在冷却"，全郣发车，然后一起撞上账号级并发上限。
冷却只能阻止"新的尝试"，阻不住"已经并发出去的那一批"。

**为什么这件事跟 exhausted 高位有关**：
并发上限被撞开后，每个 label 都在报错，而短链（reflection 只有 1 个 label）
一报错就整批全灭——那就是 `All labels exhausted` 高位和
deep-reflection 产出率 35% 的机制。**—那会回到 403 死循环。

**修法（不改 bot 怎么说话）**：给短链加一个不共用主链的备份，或者把锁冷却按错误类型分级。

**为什么不自己动手**：`.env` 注释（2026-08-19）记录当时是故意抄掉 kimi 备份的——
后台批任务的 backoff 连急过 reply 主链。两难的双方都有记录，而我不知道哪个 label 适合。
（round 80/81 的教训：`SMART_GROUP_AUTO_ASSIGN` 会屏蔽 `.env` 手动链，所以手动加 backup 可能又被旁路。）

## 第 3 档：需要人拍板的设计选择

| 决定 | 数字依据 | 代价 |
|---|---|---|
| **群聊回复走快路径** | 30s 快接 51%；36% 的 CodeAct 任务在 30-60s（round 105/106） | 那 30-60s 可能真在查东西；走快路径会少用工具 |
| 给 judge 链加第 4 个账号 | 三账号同时限流（stepfun RPM≈10）；heart LLM failed 143 次/天，57% 是 exhausted | 要多一个 provider key |
| 反广告要不要真启用 | 现在 0 群授权、纯空转 | 要群主授权（`/antiad on`） |
| **`REPEAT_ANCHOR_MAX` 2→1** | 全天 25 组"同一锚点 3 分钟内回两次"（round 123） | 咽掉 25 条第二句，其中约一半是该说的追问/回呛/安抚（round 124）**注：round 132 修了双签后这笔账才准**—双签时 Meta 路径实际按 MAX=1 跑、legacy 按 MAX=2，两条路径口径不一致 |
| 「点名 + 钩子」当心流判据 | **假设已验崩**（4% vs 3%，round 101）——别做 | — |

## 我做过但**无效**的（别再试）

| 改动 | 为什么无效 |
|---|---|
| 改 `AI_USAGE_JUDGE_BACKUPS` 加跨账号 backup | `SMART_GROUP_AUTO_ASSIGN=true` 旁路了 `.env` 手动链（`fallback.ts:24-28`）。跨账号兜底 `smart-group.ts:591` round 13 就做了 |
| 逐处删 `maxTokens: 1200` | 真闸在 `provider.ts` 的 `REASONING_TOKEN_FLOOR`（round 72 才是对的） |
| 加 dshkimi/lfree 到 judge 链 | 同上，被 auto-assign 旁路 |

## 量具的坑（我自己踩过的）

| 坑 | 症状 |
|---|---|
| self-act 的 replied 是「5 条人类消息内有人接」 | 活跃群约 3-4 分钟窗口，不是「没人理」。秒级要扫日志（round 103） |
| `--since 'YYYY-MM-DD HH:MM'` 的 padStart bug | 藏了 42 轮，任何 HH:MM 都会静默退化成全天（round 93） |
| 编辑重放算进入站 | 分母灌水，回复率被低估（round 49） |
| 累计 vs 当天、20 分钟窗口 vs 全天 | 反复犯，判据已固化进 measure-voice 和 compare |
| 自己的探针算进生产统计 | round 120：跑 LLM 探针量 LLM 健康度，那 5 个点的失败率是自己打的（真实 12% 而非 17%） |

## 诊断工具的卫生（round 120/121）

**会污染统计的**：任何打 LLM 的临时探针。Round 120 实测：跑三个探针的那小时
给生产加了 614 次 `All labels exhausted`，把全天失败率从 12% 抬到 17%。

**不污染的**（每晚 23:00 cron 跑的这四个）：

| 命令 | 读什么 | 打 LLM？ |
|---|---|---|
| `measure:voice` | 只读 `logs/app.log` | 否 |
| `measure:engage` | DB + Redis（self-act） | 否 |
| `measure:timing` | 只读 `logs/app.log` | 否 |
| `gate:evidence` | grep 日志 | 否 |

**规则**：想量某个子系统，先用这四个里能回答的那个；必须写探针时，
在报告里注明"这一段含我自己探针的调用"，或者干脆分窗口报（round 120 的做法）。

---

## 这份表里的数字都是快照，别当现值（round 130）

上面表格里的 `614 次` / `12% vs 17%` / `67 次/h` 这类数字都是
**2026-09-23 那一天的实测**，带 round 号就是为了标时点。它们会过期。

想拿现值，跑对应的工具（每个数字旁边的"怎么验"列都写了），
或者看 `logs/voice-daily.log` 里每晚 23:00 的 cron 日报。

**规则**：这份表回答"还没解决什么"和"为什么难"，不回答"现在是多少"。

---

## 八个守卫（都验过能红，别再重验）

这个仓的"没人守着的规则"已经被守卫覆盖。**每一个都在 2026-09-23 验过
"故意弄坏 → 测试红"**（round 145 逐条做的）。

| 守卫 | 抓什么 | 在哪 |
|---|---|---|
| `no-dead-switches` | 开着但没人读的 env flag | `tests/unit/env/` |
| `verify-deploy` | 改动没进 bundle | `scripts/verify-deploy.mts` |
| `verify-integration` | 单独绿、组合坏 | `scripts/verify-integration.mts` |
| `doc-references-exist` | 文档引用腐烂 | `tests/unit/docs/` |
| `census-is-current` | flag 索引过期 | `tests/unit/env/census-is-current.test.ts` |
| `objective-tools-exist` | 结论文档里捏造的工具名 | `tests/unit/docs/objective-tools-exist.test.ts` |
| `check-gate-evidence` ⑦⑧ | 闸的明细被删 / 日报缺仪表盘 | `tests/unit/scripts/check-gate-evidence.test.ts` |
| `measure-*` 的警示行 | 仪表盘丢了口径免责声明 | `tests/unit/scripts/measure-*.test.ts` |

**两条关于守卫自己的教训**（都是这个 goal 付过学费的）：

1. **`toContain` 一个字面量区分不了"机制在"和"注释提到"**（round 140/141/142）。
   断言要查**未注释的代码行 / console.log 输出行**，而且必须逐条 `-t` 单跑验红——
   "整份文件是红的"会遮住单条的假绿。
2. **验红时弄坏的那一下要弄对地方**（round 145）。我两次 tamper 错文件/错链接，
   差点把好守卫记成假绿。**先读测试再 tamper。**

Circular dependency warning: `check-gate-evidence` 的测试 ⑦⑧ 断言的是
`scripts/voice-daily.sh` 的内容，而那个脚本是**生成日报的**——如果哪天日报
改成别的方式生成，这两条会静默失去意义（它们查的是脚本文本，不是日报本身）。
真要看日报本身，读 `logs/voice-daily.log` 的最新条目。

**round 198：假说已验证。** 用现有日志就能分开两种情况（不需要新流量）：

```
events: 1275
same label, same second: 178     ← 同一秒内同一个 label 被打多次
same label, gap <=5s: 553
```

**一条串行链不可能在同一秒内打同一个 label 两次**——那只能是多个并发的
`callWithFallback` 调用（不同 chat/任务/usage）在同一刻都通过了冷却检查，
然后一起发车。178 个同秒同 label 是直接证据。

所以这不是假说，是已验证的根因：**冷却是 check-then-launch，拦不住已经并行发出去的那批。**

### round 201：**代发缺参闸从没真拦过——它的兜底条件宽到永不触发**

Round 169 上了 arity-aware 的缺参闸（`usage_syntax` 有占位 + args 空 + 人类消息没带参 → 拦）。
`gate:evidence` 一直报它 0 次，round 196 我还写了「判据场景还没出现」。

**回放发现场景发生了很多次**：

| 口径 | 数 |
|---|---|
| 全日志 `command-router: delegated learned command` | 72 |
| 其中 `usage_syntax` 有占位（闸**该拦**） | **36** |
| 其中 `/geo` 且 args 为空 | **20** |

闸的日志（`delegation: command needs an argument but none was given — blocked`）出现 **0 次**。

**根因在第三个条件**（`humanMessageCarriesArg`）：

```ts
// 任何 >=2 字的非纯标点串（关键词类参数）
if (/[\u4e00-\u9fa5\w]{2,}/.test(t.replace(/[\s\p{P}]/gu, ''))) return true;
```

群聊里最近 6 条人类消息**几乎总有**两个以上的中文字符——于是这个函数几乎恒为 true，
闸的第三条件永远满足，**闸永远不拦**。

这是本会话第 N 次「守卫自己不成立」家族：

| 轮 | 形态 |
|---|---|
| 122 | reopen gate was a no-op |
| 191 | debug 级日志 → "0 次"读不到 |
| 201 | **兜底条件宽到永不触发** |

**修法**：把「人类带了参」从「有任何中文」收窄成「有**匹配这个占位形状**的串」——
占位写 `<IP或域名>` 就只认 IP/域名，写 `[@用户名]` 就只认 @name，写 `[链接]` 就只认 URL。
认不出的占位形状 → fail-open（宁可少拦）。

### round 44：进程内闸的平均寿命是 **21 分钟**（p50 只有 7 分钟）

Round 42/43 说「进程内状态的闸在频繁重启期间是瞎的」。
把"频繁"量出来（口径：`Bot started` 的相邻间隔，09-22..23 两天）：

| 指标 | 值 |
|---|---|
| 重启次数（2 天） | **111** |
| 平均进程寿命 | **21 分钟** |
| p50 间隔 | **7 分钟** |
| 最短 | 1 分钟 |
| 最长 | 311 分钟 |

按天：09-22 57 次 / 09-23 54 次。**09-19 最凶：91 次。**

### 这对各闸意味着什么

`recentBotTextsByChat` 要攒到 **6 条**自己的发送才会开始判（`findTopicRepeat`
开头 `recent.length < 3` 直接返回）。一个进程平均活 21 分钟，而一条
`host sendText` 要等心流/模型几秒到几十秒——**平均一个进程只够发 1-2 条**。

所以 topic-word 闸在开发期基本不可能攒满窗口。这不是 bug，是
**部署节奏和闸的前提条件不匹配**。

### 可选的处置（未做，记决定）

| 选项 | 代价 |
|---|---|
| 把 `recentBotTextsByChat` 挪 Redis | 违背它存在的理由（注释：beats Redis/NyatDB lag） |
| 攒不满就放宽窗口（比如 3 条） | 误伤上升——round 162 就是为不误伤才选 3/6 |
| 什么都不做，接受"开发期这条闸无效" | 生产稳态（不频繁重启）下它是有效的 |

**倾向第三个**：开发期本来就该少发消息验证，而这条闸治的是稳态下的连发。
但要**知道**这条边界，否则会把"0 次"误读成"已修"。

---

## counters的缺席：54 个里 7 个进过文档（round 79）

Round 78 发现"缺席比拷贝难发现"。这轮把范围放到全部计数器：
全仓 `incrCounter('...')` 54 个，`grep docs/*.md AGENTS.md` **只有 7 个被提到**。

缺席 47 个里大部分是合理的（`llm_tokens_total` 这种纯度量、`bgllm_cooldown_total`
这种 round 98 以后才有的），但**有 5 个是该在表上而缺席的**：

| 计数器 | 治什么 | 状态 |
|---|---|---|
| `send_duplicate_skipped_total` | round 191 的那个"读不到" | 文档讲了 debug→info，**没用计数器名** |
| `send_repeat_anchor_total` | 重复锚点闸 | 表格讲"拦住 3 次"，**没用计数器名** |
| `send_task_burst_total` | task 级 burst 闸 | plan 里提过 |
| `llm_inflight_cap_skipped_total` | round 198 在飞上限 | **只字未提** |
| `llm_short_cooldown_total` | round 182 冷却分级 | **只字未提** |

后两个是本 session 新加的机制，**计数器名从没出现在任何文档里**——
意味着下一个人想看"在飞上限挡了几次"，得先 `grep -r incrCounter` 才知道叫什么。

### 归档：新增计数器的交付物是"名字进了哪个文档"

```
round 75 家族（五个地方只有 debug 日志）的推论：
一个计数器如果没有任何文档提它的名字，它等于不存在——
因为没人会去查一个他不知道名字的东西。
```

**处置**：在 `docs/OBJECTIVE-STATUS.md` 加一张"本 session 新增计数器索引"表，
一行一个：计数器名 / 机制 / 在哪份文档讲。这样缺席就有对象可比。


## 编辑重放占入站 15.6%（round 49 标记，round 82 复量仍在）

**问题**：`isEdit=true` 的消息占入站 15.6%（09-22 是 19%）。
round 49 已标记，至今 82 轮未解决——**"标记"和"解决"是两件事**。

**口径影响**（这是它的危害所在，不是它本身）：
  · 所有以"入站消息数"为分母的率都被灌水
  · `measure:engage` 的回复率：分子是真回复，分母含 15.6% 编辑重放 → 回复率被低估
  · `hourly-rate` 的入站速率同理

**round 49 的判断**：「修的是分母，分子没动」——但分母至今没修。

**修法候选**（未做）：
  1. `message in` 按 `isEdit` 分流计数
  2. `session-report.mts` 把编辑重放单独列一列，别混进入站
**优先级**：中。它不阻塞功能，但让所有"回复率"类结论偏低 15.6%。

---

## 排期审计：known-issues 里 4 条"待定"没有轮次（round 84）

Round 83 立的规矩：**标记一个问题时同时决定它在哪一轮修；决定不了写"待排期"，
不要写"已知"——"已知"是会被无限期推迟的状态名。**

拿它审自己这张表。`### 可选的处置（未做，记决定）` 那节里躺着三条
**没轮次**的，加上一条新的：

| 条目 | 状态 | 排期 |
|---|---|---|
| topic-word 闸攒不满窗口（进程内 Map + 重启 200+） | 已知 43 轮 | **下一轮有数据就定**：等群醒、一个不重启的 awake 周期后看 `send_topic_word_repeat_total`。仍为 0 → 按 round 42 的口径判"没机会"，**不修**（改 Redis 违背它存在的理由） |
| 进程寿命 21 分钟要不要告警 | 已知 40 轮 | **待排期**：做成 cron 需要新增 env 旗标，而它治的是开发期噪音不是生产故障。等 bot 有连续 3 天不重启再评估 |
| 编辑重放算进入站 | round 49 → 83 修了 | ✅ **round 83 已修**（报告层择出来） |
| counters 缺席（`llm_inflight_cap_skipped_total` 等） | round 79 → 80 修了 | ✅ **round 80 已修**（补进 known-issues + 守卫） |

**修完的两条都不是"排期"修掉的，是"当轮顺手"修掉的**——这更正了 round 83
的结论：它们放了那么久**不是因为贵，是因为从没被排进任何一轮**。

### 归档（补进 round 83 那条）

```
"已知"不是一个状态，是两个：
  · 已修（有轮次、有 commit）
  · 待排期（有轮次、还没做）
凡是两者都不占的，就是"放过"——而放过是这张表唯一真正的问题。
```

`scripts/session-report.mts` 的编辑重放行现在是这条规矩的实证锚点：
它从"已知"变成"已修 · round 83"，中间隔了 34 轮。


## interrupt 分桶：counter 有值但日志行 0（round 91 标记，round 92 排期）

`agent_interrupt_addressed_total` 在 `/metrics` 里有值（群醒后），
但 `grep "interrupt triage" logs/app.log` = 0 行。

**判据**：counter 和日志是两条独立的观测路径（round 63/64 立的坑，第 5 次）。
有 counter 说明代码跑了，没日志说明**日志的 msg 和我猜的不一样**或只打了 counter。

**修法**：用 `npm run log:count agent_interrupt` 看真实形状，
把 OBJECTIVE-STATUS 里那句"6 个闸在生产有证据"的引用改成真实 msg。
**状态**：待排期（round 92）。
