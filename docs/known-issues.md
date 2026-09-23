# Known issues — 这个项目现在**还没解决**的事

一张表。`voice-tuning.md` 是流水账（1826 行），这张是结论。
每条都标了**怎么验**，方便下一个人（或下croft轮）复查。

## 等生产样本的（已修，判据+位置都验过）

| 问题 | 修法 | 基线 | 怎么验 |
|---|---|---|---|
| 同一锚点被回多次 | `repliedAnchors` + 发送前读 answered 账本（round 89/90） | 修复前 343 条带锚 / 24 组重复（7.0%） | `grep -c '同一锚点短时间内已回过' logs/app.log`；分母要 >=20 条带锚 |

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

## 第 3 档：需要人拍板的设计选择

| 决定 | 数字依据 | 代价 |
|---|---|---|
| **群聊回复走快路径** | 30s 快接 51%；36% 的 CodeAct 任务在 30-60s（round 105/106） | 那 30-60s 可能真在查东西；走快路径会少用工具 |
| 给 judge 链加第 4 个账号 | 三账号同时限流（stepfun RPM≈10）；heart LLM failed 143 次/天，57% 是 exhausted | 要多一个 provider key |
| 反广告要不要真启用 | 现在 0 群授权、纯空转 | 要群主授权（`/antiad on`） |
| **`REPEAT_ANCHOR_MAX` 2→1** | 全天 25 组"同一锚点 3 分钟内回两次"（round 123） | 咽掉 25 条第二句，其中约一半是该说的追问/回呛/安抚（round 124） |
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
