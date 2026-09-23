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
