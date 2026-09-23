# Voice tuning — 让它"像个人一样说话"，以及怎么量

这份不是调参手册，是**一份实测记录**。所有数字都来自 `logs/app.log` 全量统计，
判据固化成 `npm run measure:voice`。改行为之前先量，是这个仓库的规矩。

---

## 四个数

```bash
npm run measure:voice                # 今天 UTC 0 点之后
npm run measure:voice -- --since 14:00
npm run measure:voice -- --day 2026-09-22
```

| 数 | 怎么算 | 想说明什么 |
|---|---|---|
| ① 回复率 | 首气泡 / message in | "爱说话"的外在表现 |
| ② 心流四态 | reply / react / wait / pass 各自占比 | 决策层怎么分布的 |
| ③ 重复回复率 | 多出的首气泡 / 首气泡（同一锚点被回 >1 次） | 复读 |
| ④ 撞名守卫 | 拦下几次 | 该借力别的 bot 时有没有乱来 |

**口径提醒**：`dropped duplicate reply anchor`（同一次任务内的分句去重）**不是**③。
它几百到一千多次都在正常工作，把它当重复率会得出"28% 复读"这种错 6 倍的数。

---

## 2026-09-22 的实测基线

全量（40,083 条入站 / 4,808 个首气泡）：

```
① 回复率        12.0%     ← 会话开始时是 8.2%
② 心流四态      reply 44%  react 0%  wait 0.3%  pass 55%
③ 重复回复率    4.3%（206 个多余回复；最惨的 8 个锚点各被回 5-6 次）
④ 撞名守卫      拦下 0 次（守卫当天才加）
```

按天看回复率的拐点：

```
09-17  3694 条入站 → 47 个回复    1.3%
09-18  5914         → 151       2.6%
09-19  7449         → 1341     18.0%  ← Nyat Trench 上线，涨 15.4 点
09-21  8009         → 1079     13.5%
09-22  5512         → 1000     18.1%
```

**心流 reply 占比的漂移更陡**：11%(09-16) → 45%(09-22)，而 `wait` 一天只有 0-6 次。

---

## 试过的东西，以及有没有用

### ① prompt 里加占比门槛 —— ❌ 没降回复率

`prompts/task/heart.md` 从"别把 pass 当成安全选项：想接就接"改成三关
（占比 ≥30% 默认不接 / 这条值不值得 / 说成什么样）。

**结果**：reply 44%（修前 45%），回复率没动。

**为什么没用上力**：第一关全线押在"这一波你占了多少"上，而实测那个数的分布是
——30 分钟窗口 5 个群的中位 **0.200**，落在"挑着接"那一档，那一档的措辞**仍然是"接"**。

**教训**：改的是措辞，但真正让它多说的是"人多话密时每句都觉得有意思"。
判据要落在模型实际会走到的地方。

### ② 把 wait 从一句话扩成一节 —— ✅ 生效（部分）

wait 原来只定义了一种情形（对方话说一半）。改成三种（连发中 / 话题正在展开 /
自己刚说完气没落地）+ 和 pass 的区别 + "等完能一口气回整件事"。

**结果**：wait 从 0-6 次/天 → 21 次。

**但它有个没兑现的承诺**：`Meta heart: wait` 21 次，`wait-resume → Meta Attention` 只有 1 次。
wait 说"我回来接"，20 次没接。（见 `chat-runtime.ts` 的
`wait-resume dropped: waitUntil mismatch`，round 10 把它提到 info 就是为了查这个。）

wait 只占 0.3% 很可能就是**模型试过发现没什么用**——和 react 同一类病。

### ③ 把"这条你已经回过几次"递过去 —— ✅ 重复率降了

`markMessageAnswered` 早就在记，但**读它的人里没有心流**。`answeredTimestamps()`
把次数和时间戳递过去：

```
[这条你已经回过 1 次] 最近一次 5 分钟前。除非人家追加了新内容，否则再回一遍就是在重复自己。
[这条你已经回过 3 次] 最近一次 1 分钟前。**连着接同一条，群里看着像复读机**
```

**结果**：最惨的锚点从 5-6 次降到 2 次，全天重复率 4.3%。

### ④ 撞名命令守卫 —— ✅ 拦住两次真误代发

`nmnmfunbot /checkin` 是已学命令，而本 bot 自己也有 `/checkin`。生产中两次误代发：

- 用户说「等下又要签到水句开盲盒了」→ bot 向 nmnmfunbot 发了 /checkin
- 用户说「争取以后能有一周的全勤吧」→ 又发一次

守卫：撞名命令必须**显式点到目标 bot** 才代发，否则回落 LLM judge。

### ⑤ react 第四个出口 —— ⏳ 还没量到

心流只会 reply/wait/pass 的时候，想说"对对对/笑死"也只能发一条文字气泡——
哪怕 prompt 写了"2-10 字的微反应更自然"，机制上没有更便宜的出口。

加 `act=react` → `setMessageReaction`，对回复率分子零贡献。
**量到 0 次**：加完之后 bot 一直处于 asleep，没有流量。等 awake 才能说有没有用。

---

## 下一个该试的

占比门槛和 react 都没动点了的话，只剩 host 侧。三条候选，都动"心流说了算"这个立场：

- **A. reply 后 N 秒内同群被动消息不进心流（冷却）**——不动模型决定权，只让话密的几分钟自然错开
- **B. 单群每小时 reply 上限（配额）**——最直接，但 round 97 删过的那种
- **C. 先修 wait 的回访**——wait 承诺了不兑现，模型就不用了；修好它可能比加新机制管用

**我倾向 C**：它是唯一一个"机制已经写了但没跑通"的，修好它等于把已经付了钱的
东西收回来。A/B 都是新增约束，而这个会话的经验是新增约束容易,
让它真的跑通难。

---

## 一句话总结这轮

> 判据改了，机制没给 —— 是这个仓库反复出现的失败形状。
> prompt 让它少说（①）、让它知道自己回过了（③），都是判据；
> 真的给它一个更便宜的出口（⑤ react）、让它承诺的回访真的发生（②），才是机制。

---

## 什么时候真的有流量（20 轮才写下来的一张表）

round 19 修完 maxTokens 写死，我一看"截断从每小时 80 次降到 2 次"，几乎要宣布修复成功。
同期睡眠门 `asleep 1083`——**那个 2 是夜间窗口的 2**。

`getSleepPhase()` 的相由 `daySchedule()` 决定（date-seeded，每天重新摇）：

```
wakeMin  = 456  → 北京 07:36 起床
sleepMin = 1432 → 北京 23:52 就寝
napStart = 791  → 北京 13:11 午睡
napEnd   = 835  → 北京 13:55 午睡结束
```

**结论：想量心流行为，必须用 awake 段的数据。**

- awake 段：北京 `wakeMin` → `sleepMin`，扣掉 nap 段
- nap 段和 night 段一样，`metaSleepGate` 对 L2 非直呼直接 `silent`
- `npm run measure:voice -- --since HH:MM` 的 **HH:MM 是 UTC**，比北京慢 8 小时
- **`daySchedule(DATE)` 要的是北京日期**，不是 UTC 日期。UTC 22:50 时北京已经
  是明天 —— 这个错让 round 23/24 连着绕了两次
- 换算表（round 24 用真实时钟对过）：

  | 想要 | 命令 |
      |---|---|
  | 今天起床后的全部   | `--day` 不用，直接 `npm run measure:voice`（脚本内部用 UTC 0 点切天） |
  | 起床后到现在       | `--since` + UTC 时刻。北京 07:36 起床 → `--since 23:30`（**UTC 前一天**） |
  | 今天北京哪天起的   | `npx tsx -e "import {daySchedule} from './src/tracking/life-state.js';console.log(daySchedule('<北京日期>'))"` |

- 一条不会错的自检：`TZ=Asia/Shanghai date '+%m-%d %H:%M'` 和 `date -u '+%m-%d %H:%M'`
  对着看。**北京 06:56 时 UTC 还是前一天 22:56** ——日期都不一样，
  这个小时里所有"今天"都是有歧义的
- 查今天的作息：

```bash
npx tsx -e "import {daySchedule} from './src/tracking/life-state.js';
const d = daySchedule('YYYY-MM-DD');
console.log('起床', String(Math.floor(d.wakeMin/60)).padStart(2,'0')+':'+String(d.wakeMin%60).padStart(2,'0'),
            '就寝', String(Math.floor(d.sleepMin/60)).padStart(2,'0')+':'+String(d.sleepMin%60).padStart(2,'0'));"
```

**一条粗暴的自检**：`grep -c 'Meta path: asleep' logs/app.log` 如果远大于
`grep -c 'Heart decision' logs/app.log`，你读的就是夜间窗口，
任何"心流行为"的结论都不适用于白天。

---

## 拧哪个螺丝：让它安静下来的操作手册

前面都是"我试了什么、结果如何"。这份是**你现在就能拧的**，
按代价从低到高排。每一档都写清了它动的是判据还是机制、
会不会动"心流说了算"那个立场。

### 第 0 档：先量，别猜

```bash
npm run measure:voice -- --since 04:00     # UTC，北京 12:00 之后
```

看 ⑤睡眠门 和 按群那张表。如果 `asleep` 远大于 `到心流`，
你在读夜间窗口——回去看上面"什么时候真的有流量"。

看 ① 回复率 和 **条/小时**。这两个是**不同的病**（round 17）：

| 症状 | 看哪个数 | 说明 |
|---|---|---|
| "它占了我看到的多少" | ①回复率 | 群也热时常是正常的 |
| "它又说话了" | 条/小时 | **这才是"太爱说话"** |

### 第 1 档：改 prompt（不动立场，最小代价）

`prompts/task/heart.md`。三个可拧的点：

| 拧哪里 | 效果 | 风险 |
|---|---|---|
| 第一关占比阈值（现在 ≥30%） | 降到 20% 更多群落到"默认不接" | 它可能在该接的时候也收着 |
| 节奏那句的阈值（现在 5 条/时） | 降到 3 让"挺密的"更早出现 | 同上 |
| "什么时候 reply"那段 | 删掉 `"我想说"本身就是足够的理由` 这类鼓励 | **人格会变钝**，这是它为什么像人的部分 |

改完必跑 `tests/unit/pipeline/heart-prompt-balance.test.ts`——
那条测试锁的是结构，不是字面。改坏了它会告诉你哪里塌了。

### 第 2 档：改 usage 配置（不动代码，不动立场）

`.env` 里这些直接影响心流能说什么：

```
# 用法：AI_USAGE_<NAME>_<FIELD>，NAME 就是 USAGE_PROFILES 的 key
# （judge / reply / summarize / vision / deep_think），字段白名单在 env.ts:347
AI_USAGE_JUDGE_MAX_TOKENS       # 太小 → 思维链吃光 → heart fail-closed pass
                                 # （round 19 修的是调用方写死；这里管配置值）
AI_USAGE_JUDGE_TIMEOUT          # 太小 → 超时 → fail-closed pass
AI_USAGE_JUDGE_BACKUPS          # 链长一点的兜底
SELF_HISTORY_WINDOW_MIN         # 心流看"我最近说了多少"的回看窗口
HEART_COOLDOWN_AS_FACT          # true = 把冷却期当作事实递模型，false = host 直接拦
```

**`HEART_COOLDOWN_AS_FACT` 是设计立场的关键**：`true` = host 只报告状态，
模型自己决定；`false` = host 直接拦。想少说话又不想破坏立场，把它开成 `true`
同时把 prompt 第一关收紧——**让约束可读，而不是让约束隐形**。

### 第 3 档：host 侧节奏上限（**动立场，要你拍板**）

前面两档都不拦它，只是让它知道。第 3 档是真的拦：

- 单群 reply 后 N 秒内被动消息不进心流（冷却）
- 单群每小时 reply 硬上限

为什么不在这份文档里直接给你：这两个都让 host 从"报告状态"变成"做决定"，
而这个项目最不一样的地方恰恰是前一件。round 97 删过一次配额，
理由记在 `src/ai/smart-group.ts` 的注释里。

**要上的话我会先量一周的条/小时分布，把上限设在不误伤活跃群的位置。**

### 我建议的顺序

1 档 → 量一天 → 还不够再 2 档 → 再量一天 → 还不够才谈 3 档。

跳级的结果我见过：round 3 我直接改 prompt 的第一关，
治的是占比，而真病是条/小时——**改了 17 轮才量对**。

---

## 让它自己记账：cron 每天收一次（round 30）

"该量的时候没量"在这个会话发生了 6 次（round 14-19 每轮都差 20-30 分钟到 awake
窗口，于是每轮都拿夜间数字下结论）。所以把"量"这件事从人身上挪走：

```bash
bash scripts/install-voice-daily-cron.sh     # 装：每天北京 23:00 收一次
bash scripts/install-voice-daily-cron.sh --uninstall
bash scripts/voice-daily.sh                  # 手动跑一次
```

写进 `logs/voice-daily.log`（滚动保留最近 4000 行 ≈ 60 天）。
它只记账、不告警、不决策——**它的全部价值是让"该量的那天有数"**。

装完亲眼确认过三件事：重装不会变两条、卸载干净、手动跑有输出。

---

## 一句"我现在该量吗"：`npm run voice:phase`（round 38）

cron 解决"该量的那天有数"，`compare` 解决"两个窗口能不能比"。
但**实时问一句"现在量得到白天口径吗"**还要人肉对 UTC / 北京 / `daySchedule()`
——round 24 我为此连错三次，round 14-19 因此空转六轮。

```bash
npm run voice:phase      # 退出码 0 = 可以量，1 = 量了也不算白天口径
```

```
现在  北京 07:39（UTC 23:39）
相    awake
awake 段 07:36-23:52 扣掉 13:11-13:55

✓ 可以量。npm run measure:voice -- --since 23:36
```

夜间长这样：

```
相    night
awake 段 还没到起床点 07:36
✗ 现在量到的任何"心流行为"结论都不适用于白天。
  metaSleepGate 会静默掉绝大多数被动消息（⑤睡眠门那一行）。
```

nap 段同样判 1。

三个时刻都反向验过退出码（awake=0 / night=1 / nap=1）。

---

## 窗口起点用 phase 打印的值，别自己近似（round 41）

第七次"窗口差几分钟、结论就反了"。

`voice:phase` 打印的 `--since` 值是它按 `daySchedule()` 真算的。**用它，别近似。**
这次我图省事敲了 `--since 23:30`（正确是 `23:36`）：

```
现象  14 入站 / 11 silent / 0 到心流  ->  看着像"心流完全被门挡死"
实际  那 11 次 silent 逐分钟数是 23:30 / 23:31 / 23:32 UTC
      = 北京 07:30-07:32，全在起床点 07:36 之前
      23:36 之后 silent = 0，phase=awake 分支如预期 return continue
```

门是对的，窗口是错的。**同一个日志，换个起点，故事完全反过来。**

---

## react 的验收判据：不是 react>0，是 react / 机会分母（round 43）

第一次拿到 awake 段的心流数据（n=2），react=0。但看那两条的 `why`：

```
act=reply  why=干活正上头呢，手痒想测降智玩？    <- 想展开说，reply 对
act=pass   why=AI降智话题不感兴趣，早读偷瞄呢     <- 没感觉，pass 对
```

**没有适用场合时 react=0 是正确行为。** 拿 react>0 当验收会把"没场合"
算成失败——那是个永远达不到或永远误判的判据。

反查历史（10,141 次决策 / 2,913 次 reply）找机会分母：

| 口径 | 机会数 |
|---|---|
| why 含反应词 | 1,084（太宽，"划算吗""售后待审核"都算） |
| why ≤8 字 + 无疑问 + 含反应词 | **4** |

那 4 个是：`这价格离谱到笑死` / `这反差感绷不住喵` / `牛来自我回复好笑` /
`这梗接得挺乐喵`。而 react 用了 0 个。

**验收入口：`react 数 / 机会分母`。** 分母 0 时 react=0 是对的；
分母 >0 而 react=0 才是该 react 没 react。

顺带一个更可能的病因：整个历史只有 4 次"一个字就能说完"的冲动，
说明模型**不习惯把 react 当选项**——它的 why 总写成一句话
（"这价格离谱到笑死"而不是"笑死"）。若如此，问题不是 react 用得少，
是 prompt 没让它把"只想给个反应"识别成一个独立冲动。

---

## ④ 的修复效果：按部署点切窗口才看得到（round 45）

全天"思维链吃光"952 次，差点被我报成"④ 没修好"。逐小时数：

```
17UTC  39 次   <- round 19 修完之后（那轮只修了 2 处）
18UTC  40 次   <- round 19 修完、round 26 未修（还有 5 处）
19UTC   1 次   <- round 26 修完之后
23:05 UTC（round 26 部署）之后 53 分钟窗口：0 次
```

全天 952 次绝大部分在修复之前。round 19 只修 2 处，所以 17-18UTC
还有 79 次；round 26 补齐另外 5 处后归零。

这正是 round 31 给 `compare` 写的禁结论判据——**窗口不同不许下结论**。
单看全天 952 会得出"修复无效"，按部署点切窗口才看到真相。

顺带确认 ④ 的影响面是 100%（每一次 judge 调用都过 maxTokens，不经漏斗）。
②③ 的影响面还没这样直接数过——记在这里，是个待办。

---

## 今天 awake 段第一批：reply 80%，但 n=5 禁结论（round 47）

```
13 入站 / 5 到心流 / reply 4 / pass 1
① 回复率 15.4%（全天口径 15.5% —— 一致，这个数稳定）
```

`reply 80%` 看着比全天 44% 高。按 round 43 立的规矩（n<20 禁结论）不能读。
而且 round 46 刚数出心流只影响 13% 流量——早上这 5 次恰好是那 13% 里
最容易接的（刚醒、有人喊、群里在开玩笑）。

那 4 次 reply 的 why 全是该接的（"刚醒就被喊""这直球表白太猛了"），
pass 那次也接得对（"他俩唠嗑跟我没关系"）。**没有一次是硬挤的。**

所以早上的 80% 很可能就是正常的：早上人少、话题集中、容易被点名。
不是模型变爱说了。

**可读的只有一条**：①回复率 15.4% vs 全天 15.5% 几乎一致——
这个数是稳态的，而 round 17 定位的"条/小时"才是体感来源。

---

## 回复率被编辑重放灌水了三分之一（round 49）—— 一个我早就标记却放过的问题

round 15 我标记过"`isEdit` 污染入站分母"，当时的决定是
"不改口径（历史不可比），但两个都报"。**那个决定让之后 34 轮的回复率全部系统性偏低。**

```
今天 08:09 前：54 入站 = 22 新消息 + 32 编辑重放（59%）
全天 09-22：  6,957 入站 = 5,657 新消息 + 1,300 编辑重放（19%）

回复率（旧，含编辑）  15.5% 全天 /  9.6% 早上
回复率（新，扣编辑）  19.0% 全天 / 31.8% 早上
```

**修的是分母，分子没动。** 编辑重放不是消息——它是同一条被改过的内容
再次投递，bot 不该因为它被编辑就再回一次。把它计进入站等于
"群里来了 54 个人说话"，实际 22 个。

`measure:voice` 现在按新消息算回复率，并在 `message in` 那行把编辑数列出来。

**它改变了对①的判断**：round 17 定位"真病是条/小时"仍成立（排序确实更接近体感），
但占比本身被低估三分之一。早上真实回复率 31.8%（不是 9.6%）——
已经接近"每三条回一条"，用户说"太爱说话"比我以为的更严重。

（n=9 禁结论。但这个口径错误影响过去 34 轮的所有回复率数字。）

---

## ③ 的一个真实缺口：心流路径不 mark answered（round 52）

今早重复率 0.0% → 12.5%（2/16）。追下去发现 **round 4 只修了一半**：

`markMessageAnswered` 全仓 7 处调用，但分布是

```
src/subagent/host-api.ts          6 处   ← Subagent 路径
src/subagent/post-task-window.ts  1 处   ← Subagent 路径
src/meta/dispatch-gate.ts         1 处   ← 但那是 no_action 分支（没回才标）
```

**心流产出 reply 的主回复路径一次都没 mark**（`heart.ts` 只返回
`judgeResult`，之后由 pipeline/sender 发出）。于是"这条我回过"这个事实
对心流的下一次决策不可见——8 分钟后对同一条又回一次，每次都以为
自己是第一次。

全天 1.9% 是因为多数重复发生在 Subagent 路径（mark 覆盖到的那部分）；
心流路径一旦重复就完全没拦。**这不是"修完了"，是一个待补的缺口。**
修它要动发送公共出口（`src/bot/sender/telegram.ts`）。**round 52 已经修了**；那时还没动手。

---

## react=0 的真因：Meta 路径不认 act=react（round 54）

北京 12:19 拿到大样本，**react 第一次非零（9 次，n=596）**，why 都合理
（"笑死，欲火焚身可还行"、"测速满血，赞一个喵"）。但表情一个都没发：
`heart: reacted` 和 `Model-chosen reaction sent` 都是 0 条。

定位：`'Heart decision'` 日志唯一来源是 `decision.ts:394`，
调用它的是 `heart.ts:236`（pipeline 路径）和 `heart-adapter.ts:206`（Meta 路径）。
**heart-adapter.ts 只判 wait 和 pass，act=react 落到默认分支被丢掉。**

而 Meta 是现在的主路径（`group_chats_processed` 105 vs legacy 7）。
所以 9 次 react 全在 Meta 上被判了、然后静默丢弃。

round 8 我说"机制已接"——只接了 pipeline 那条，没接生产真正走的 Meta。
这和 round 4（只接读不接写）、round 19/26（只修 2 处漏 5 处）是同一形状：
**改了 A 路径就宣布做完，而生产走 B 路径。**

待补：`heart-adapter.ts` 的 react 分支（`reactToMessage` + `recordDecision` +
返回 silence）。

---

## ③ 修复后第一批数据：33.3% → 3.8%（round 55）

按小时拆，**修复部署在 00:2x UTC**：

```
00UTC  first=12  extra=4  33.3%   <- 修复之前
01UTC  first=36  extra=1   2.8%   <- 修复后
02UTC  first=28  extra=1   3.6%
03UTC  first=28  extra=1   3.6%
04UTC  first=12  extra=1   8.3%
00:2x 之后合计 first=104 extra=4 = 3.8%
```

**修复前那一小时 33.3%，修复后 3.8%**——这正是 round 45 的教训：
按部署点切窗口才看得到效果，全天累计 3.1% 是个混合数（含修复前的 4 个）。

n 仍小（每小时 first 12-36），3.8% 本身也禁结论；但逐小时都落在
2.8-8.3% 窄带里，不是修复前那个 33.3%。

**react=9 全是修复前的决策**（Meta 分支 04:31 UTC 部署，那 9 次在
01:21-04:11）——`Meta heart: reacted` 0 条是预期的，不是失败。

今天的全天口径（n=608）：① 20.1% / ② reply 11% react 1% wait 0% **pass 88%** /
③ 3.1%（含修复前）/ ⑤ 到心流 608。

pass 88% 说明心流绝大部分时候选择不接——"太爱说话"更多是绝对节奏问题：
最吵的群 17.7 条/时，而占比只有 19.6%。

---

## "前言不搭后语"的主因：心流的 why 9% 是脏 JSON，直接喂给写手（round 58）

巡检：各部分都在跑（Heart decision 24/小时 · CodeAct 15 · Knowledge sync 10 ·
Vision 2 次失败有占位 · 延迟 P50 19.7s）。无系统级故障。

但"前言不搭后语"有具体机制。实测 10,807 条 Heart decision：

```
why 含 `{`          926 条（9%）
why 长度 >=38（截断） 164 条（2%）
```

那些 why 长这样：

```
{doro发的众筹澳门家宽，倍率还行，要参吗？
{刚撩猫羽就发男铜贴纸，这反差绷不住
```

`parseHeart` 的 `why: String(obj['why'] ?? '').slice(0, 40)` 原样收下模型
塞进来的引用链/嵌套 JSON 片段，然后这条字符串被注入

```
reply.ts:623  [你的念头] 你看到这条消息时心里想的是:「{doro发的众筹澳门家宽…」。
```

写手拿到一个**断裂的 JSON 片段**当"念头"，还被要求
"顺着这个念头说，别另起炉灶"——9% 的回复带着坏念头开笔。

**排除的嫌疑**：回复不带引用不是原因。prompt 的引用规则是对的
（该引才引），60% 无锚点是设计；锚点年龄 P50 32s 也新鲜。

**待修（按性价比）**：
1. `parseHeart` 的 why 清洗 + 注入前校验（主因）
2. 30s 内同群同文本去重（实测 2 次/2h）
3. Vision 失败的降级链

---

## "难融入话题"的真相：不是融不进，是在一个群里刷同一个梗 14 遍（round 61）

用户："我觉得 bot 还是很难融入话题"。量出来是 **ignored 68%**（5 群 66 次发言）。
逐条看最惨的群（-1004430867819，0/18），发现不是融不进：

```
04:49  30%？三遍才回 / 哇哇什么，鱼干都要晒化了
04:50  慌什么，又没炸你节点 / 节点炸了而已，你机子又没被拿去晒
       节点炸了而已 你慌什么 / 鱼干翻个面继续晒，慌什么
04:51  你这慌慌张张的样子，比全红节点还吓人
04:53  护士姐姐也救不了这破节点 / 护士帽都要吓掉了
04:54  十字都吓歪了，节点而已
04:55  十字架都扶不正了还管节点 / 护士姐姐别慌，节点我来救
04:56  没炸就没炸，发这么大火干嘛喵 / 吐槽的是大盘鸡，没说你喵
```

**而群里的人已经在纠正它**：

```
@hunhebi_bot 再说一次，我的节点没有炸（生气）
噗，人家又没说你节点炸。30%回复率那不叫正常，那叫随缘。
```

人在纠正，它还在刷。0% 有人接的真相：它刷的内容没人想接
（同一个梗第 14 遍），而人只在纠正它——**"纠正"没被算进
replied/reacted，所以我量成了 0%**。

## 全群量：60s 窗口内的最大发言条数

```
-1004430867819  21 条 / 最多 5 条   ★刷屏
-1003350411234   13 条 / 最多 4 条   ⚠
-1004451430063   10 条 / 最多 4 条   ⚠
-1003821093564    9 条 / 最多 2 条   ← 最活跃的群反而最克制
```

8 个群里 6 个有 60s 内 >=3 条。**round 60 加的同文本去重挡不住
"同一个梗换着说法说 14 遍"。**

## 机制缺口

1. round 60 的去重太窄：只有**完全相同**的文本才算重复。
   "节点炸了而已，你慌什么" vs "节点炸了而已 你机子又没被拿去晒"
   文本不同、是同一件事。
2. 没有"这个话题我接过几次了"的事实。self-history 的 shareOfConversation
   是占比，不是"同一锚点/话题的接续次数"。
3. 人的纠正（@bot + 负面词）没有硬停止语义。

## 待修（三个候选，需拍板）

- **A** 同 anchor 的回复间隔下限（接过的话题 N 分钟内不再接）
- **B** burst 上限按"语义相似"而非"完全相同"
- **C** 把"人在纠正"（@bot + 负面/生气词）当硬停止信号

倾向 C + A：C 是止损（人已经不高兴必须停），A 是预防。
但这动心流接话频率，属操作手册第 3 档。

---

## "pass 88%"不是坏掉不说话——真相同质性验过了（round 66）

今天全天：reply 12% / pass 88%（对比 09-22 修前 reply 45% / pass 55%）。

第一眼看到"全天 pass 11819 次里 3914 次 why=llm_failed"，
差点判定"round 3 的 prompt 把 bot 从太爱说变成坏掉不说话"。

**那是跨 6 天的累计**。按天拆：

  09-18 70 · 09-19 521 · 09-20 1251 · 09-21 1122 · 09-22 876 · **09-23 62**

今天 llm_failed 只占 8%，剩下 25 个百分点的 pass 是真的"选择不说"。
（同一个"累计 vs 当天"的坑，这个会话付过 round 45/55 两次学费。）

## 同质性也验了，是好消息

09-23 真实 pass **684 次里有 537 种不同理由**，最高频只占 1%。
它真的在读上下文，不是走模板。

那"12 次 pass 全是同一句"的观察是**采样太小**（12 条里 6 条同句纯属偶然）。

---

## round 65 的归因错了：`zz lll` 不是乱码，是群友昵称（round 66 修正）

Round 65 我看到六连发的 `zz lll` / `zz lll 的` / `zz lll 的节点`，
判定"模型抽风输出垃圾字符串"，还把这个错误结论写进了 commit message
和源码注释。

**round 66 一个 grep 就推翻了**：

```
'zz lll' 全日志 27 次，按 msg 分：
  message in   1 次  "zz lll 已通过入群验证。"   ← 群友昵称就叫这个
  host sendText 8 次  "zz lll" / "zz lll 的"      ← bot 在叫那个人
```

所以那是 bot 在 66 秒内**反复叫同一个人的名字 6 次**，不是乱码。
性质不同（重复提及同一对象 vs 输出乱码），但仍然是刷屏，
dedup 的目的和判据都不用改。

**教训**：先定性再动手。我看到一串无意义的拉丁字母就下了"乱码"的结论，
而它只是在喊人。同一个 grep 我在 round 65 也跑过（`grep -c 'zz lll'`
= 27），但我只看了总数、没看它出现在 `message in` 里——
**那一步就是答案**。

（这也是本会话第 N 次"用错归因"：round 17 占比而非节奏、
round 14 睡眠相当空闲、round 61 12 次 pass 当同质、
round 45/55 累计当当天。已全部记在案。）

---

## "很难融入话题"的真凶：33% 的回复被自己的闸咽回（round 68）

Round 11 重测 ignored（round 60 基线 68%）→ 77%。逐群查时撞见一条
从没细看的日志：`host sendText: BLOCKED by trench gate (active speech)`。

全量统计：**1116 次回复被吞，why=just_answered 占 1096 次（98%）**。

按分片位置拆：

```
part1/1   555 (49%)  ← 整条回复没了，群里什么都没看到
part2/3   240 (21%)  ← 第 1 片发了第 2 片被吞 → 半句话
part2/2   166 (14%)
part1/3    99 ( 8%)  ← 三分句只发后两片
```

09-23 当天：想发 543 / 实际发出 365 → **33% 被咽回**。

### 病因

`NYATOS_BUDGET_MIN_GAP_ADDRESSED_SEC=30`（`src/env-sections/life.ts` 默认值）。
它的文案是"你 X 秒前才回过话，连得太密了"——**30s 对被叫到的消息太长了**：
群聊里三个人连着问三个问题是常态，bot 回第一个就被锁 30 秒，剩下两个都咽掉。

两种伤害对应用户的两个抱怨：

| 现象 | 伤害 |
|---|---|
| 49% 整条吞 | **很难融入话题**（想回但群里看不到） |
| 35% 分片被吞 | **前言不搭后语**（发出去半句话） |

### 修：30 → 8

改默认值而不只改 `.env`——`.env` gitignored，改它不留痕也不可复现。
`.env.example` 补上并写清理由。

这个闸是 round 6 为压刷屏加的（当时最忙群 19.4 条/小时）。
现在刷屏已由 round 62/63/65 三套去重+止损接管，副作用大于收益。

## 顺带：截断的根因 .env:364 早就写着

`claude: 空正文 —— 思维链吃光 max_tokens` 追下去是 stepfun 三个标签
（vision 97 / stepfun 89 / think 53，maxTokens 全 1200）。而 `.env:364` 原话：

```
# step-3.7-flash 易把 max_tokens 吃光成空 content; 账号 RPM≈10 勿当热路径主选。
```

**第 N 次"答案早就写在配置注释里"**（round 19 找 reply ts config /
round 39 内置 skill 重叠 / round 57 bot_interactions）。

---

## 4000 下限仍不够少数 prompt，且重试没兜住（round 73 待查）

Round 72 把 `REASONING_TOKEN_FLOOR` 从 1200 抬到 4000。效果：

```
修复前（00:00-09:39）：365 次 / 579 分钟 = 37.8 次/h
修复后（09:39-09:55）：  2 次 /  16 分钟 = 12.2 次/h
```

降了 68%，但没归零。残余两次：

```
09:47:49  label=stepfunthink  maxTokens=4000 outputTokens=4000
09:50:13  label=stepfun       maxTokens=4000 outputTokens=4000
```

即那 2 个 prompt 的思维链 > 4000（round 72 注释预见过：
"maxTokens=8192 outputTokens=8192 ← 长 prompt 上连 8192 都被吃光"）。

**但真正的问题是重试没兜住**：`callClaude` 有
`if (first.truncated) → 抬到 retryBudget (= budget*2 = 8000) 再试一次`，
而这两次之后日志里**一条重试记录都没有**（`思维链吃光额度导致空正文`
info/debug 各 0 条，debug 全日志也是 0 条——说明不是"firstTime=false 走了 debug"）。

已排除的：
  · 进程只一个（systemd MainPID = 1836356，两个 pgrep 命中之一是子 shell）
  · dist 里 floor 确实是 4e3
  · `truncated = !finalText && stop_reason==='max_tokens'` 与 warn 的条件
    互斥不成立——warn 打了就必然 truncated=true
  · `callClaudeOnce` 全仓只有 `callClaude` 一个调用方

**结论：这是个没查完的真缺口。** 下次从"这两次请求走的是哪条分支"入手
（`label.apiFormat === 'claude' && !carriesMedia` 才进 callClaude；
带媒体或 forceRaw 会去 callOpenAIRaw——但那条路的 warn 字符串全仓只有一处）。

---

## 一个排不光的不可能：warn 出了而重试的 info 没出（round 74 待解）

Round 73 遗留的缺口，这轮把能验的全验了一遍，**每一环都对，结论却矛盾**。

### 事实

09:47:19 / 09:47:49 / 09:50:13 三条 warn：

```
label=stepfun       maxTokens=4000 outputTokens=4000
label=stepfunthink  maxTokens=4000 outputTokens=4000
label=stepfun       maxTokens=4000 outputTokens=4000
```

而 `claude: 思维链吃光额度导致空正文 → 抬到下限重试一次`
（info 或 debug）**0 条**。

### 逐个排掉的

| 检查 | 结果 |
|---|---|
| 进程唯一性 | 只有一个（systemd MainPID = 1836356，起于 09:46:43；另一个 pgrep 命中是子 shell） |
| pid 匹配 | 三条 warn 的 pid 都是 1836356 ✓ |
| dist 的 floor | `REASONING_TOKEN_FLOOR = 4e3` ✓ |
| dist 的重试分支 | `if (first.truncated) { ... log7(...) }` 在 ✓ |
| dist 的 truncated 回传 | `return { result: {...}, truncated }` ✓ |
| label 格式 | stepfun `fmt=claude`、`stream/raw/effort` 全 undefined → 必进 callClaude ✓ |
| isReasoningModel | `/^step-/i.test('step-3.7-flash')` = true → needsFloor=true ✓ |
| warn 与 truncated 的互斥 | warn 的条件 `!finalText` 与 `truncated` 的 `!finalText` 同源 → warn 打了就必 truncated=true |
| logger.info 通路 | 同一文件的 `'prompt cache'` info **29 条在** ✓ |
| 日志丢失 | app.log 单文件 79MB 未 rotate ✓ |
| 单测复现 | `重试也截断` 用例通过（模拟环境逻辑对） |

### 结论

**不是没走到，是走到了却没打日志。** 这一步我排不光。

可能的最后两个方向（都没验）：
1. `logger.info` 在那个闭包里被 esbuild 的变量提升/重命名改了指向
   （dist 里叫 `log7`，理论上是同一引用）
2. 那条 warn 其实来自**重试后的第二次** `callClaudeOnce`，
   而第一次的 warn + info 都在更早——但同窗口只有这 3 条 warn，
   且 09:47:19→09:47:49 隔 29 秒、label 不同，不像同一次重试

下次带上 `pino` 的 `hooks`/`mixin` 或者直接在 `callClaude` 里加一条
无条件的 `logger.debug('callClaude enter')` 再观察。**比继续静态推演快。**

---

## 全天体检：三个修复的累计效果 + vision 失败在降（round 76）

### 三个修复的同日对比（09-23，按部署点切窗口）

```
窗口              分钟   BLOCKED/h   空正文/h
07:11 前          429       25.0       40.4
07:11-09:39       148       18.2       30.8
09:39 后           30        4.0        6.0
```

**BLOCKED 降 84%、空正文降 85%**（09:39 后只有 30 分钟样本，禁结论；
稳态看今晚 cron）。

### 全仓门禁全绿

typecheck 0 error / lint 0 error / verify-deploy 75/75 /
verify-integration **31/31**（dshkimi 限流那条也过了）。

### vision 失败连降四天（无新 bug，是旧修复在生效）

```
09-18 127 · 09-19 252 · 09-20 437 · 09-21 384 · 09-22 167 · 09-23 37
```

今天的 37 次成因：

```
21  Client network socket disconnected   ← 代理下 TLS 断流
10  All labels exhausted (cooling)        ← LLM 链
 2  Rate limited (concurrent 9/limit)     ← provider 限流
 2  HTTP 403 concurrency                  ← provider 限流
```

**这一条是"看着像新 bug 其实是旧修复见效"**：09-20 的 437 次里
`All labels exhausted` 占 560/1134，正是 round 72 抬下限修的那一家；
09-21 之后归零，vision 失败随之连降。

顺带确认 `installGlobalFetchProxy`（`src/shared/fetch-proxy.ts`）
已正确接管 `globalThis.fetch`，所以 `vision.ts:122` 那个裸
`fetch(fileUrl)` 也走代理——不需要单独修。
（round 63 我一度以为它是漏的，那次是为 getChatMember 写的curl；
裸 fetch 这条路本来是通的。）

---

## 产品层体检：前言不搭后语没复现，84% pass 的真相（round 79）

### 抽样 94 条有锚回复（近 2 小时）

```
锚'他那个新套餐刚上火山就没了' → '上架即绝版，限时皮肤都活得更久点'   ✓
锚'直接曝光了我三次'          → '废话，群里就你烂活最多，不写你写谁'   ✓
锚'没空'                     → '一个睡觉一个没空，你们对完口供了吧'   ✓
锚'可以定制啊'                → '哦，还能定制啥'                     ✓
锚'定制价格emmm'              → '价格咋样，别太离谱喵'               ✓
锚'作者上线了'                → '猜对了？'                           ✓
```

**前言不搭后语在产品层没复现。** round 59（why 清洗）+ round 65（前缀去重）
两个修复看起来真的生效了。

### 但 self-act 显示 replied 从 17% 掉到 4%——差点又误判

```
round 60（3h 66 次）：replied 17% · reacted 3% · ignored 68%
现在（4h 182 次）：    replied  4% · reacted 6% · ignored 77%
```

看着像"round 3 的 prompt 重写把 bot 变得太安静"。**又是累计 vs 当天的坑**：

```
09-22 全天（round 3 修前）：reply 45% · pass 55%
09-23 全天（round 3 修后）：reply 15% · pass 84% · react 3%
```

全天口径下 reply 只从 45% 掉到 15%，不是 4%。而各群实际发送量健康
（大群 90-135 条/10h = 9-13 条/h）——**它不是变安静了**。

### 84% pass 的真相：分母里大量是不需要回的消息

今天 1131 次真实 pass，**785 种不同理由，最高频只占 1%**
（"跟我无关，懒得接" 15 次）——它真的在读上下文。

而心流被调用 1181 次、pass 996 次的原因：漏斗带进来的
（`bot未叫本喵 477` / `coalesce 85` / `绕过直摄 79`）大量是**不该回的**。

### 真问题：pass 里 11% 是 llm_failed（134 次）

```
71  All labels exhausted (candidates cooling down)
38  The operation was aborted due to timeout
 7  HTTP 403 concurrent request limit
 8  Content rejected
```

**这 134 次不是"选择不说"，是坏掉不说话。** round 78 刚把
deep-reflection 摘出 stepfun 账号，心流自己还在那张账号上
（`AI_USAGE_JUDGE_LABEL=stepfun`，近 1 小时 179 次 Heart decision）。

下一个可攻的点：心流也该有账号隔离，或者 stepfun 该降级成 backup。

---

## round 80 的改动大半无效：`SMART_GROUP_AUTO_ASSIGN=true` 旁路了手动链（round 81 记）

### 我改了什么

`AI_USAGE_JUDGE_BACKUPS=stepfunjudge` → `stepfunjudge,lfree`，
配上 5 条测试先红后绿，以为解决了 round 79 指出的"心流还在单账号上"。

### 实际没解决

10 时后 `heart LLM failed` 仍 37 次，其中 23 次还是
`All labels exhausted (all candidates cooling down)`。

### 根因：`.env` 的手动链被 auto-assign 旁路

`src/ai/fallback.ts:24-28`：

```ts
const manualNames = [usage.label, ...usage.backups];
let candidateNames = manualNames;
if (isAutoAssignEnabled()) {
  const auto = await smartGroupAutoAssign(options.usage);
  if (auto.length > 0) candidateNames = auto;      // ← 手动链整条被换掉
}
```

而 `SMART_GROUP_AUTO_ASSIGN=true`（.env:738）。

**所以我改的 `AI_USAGE_JUDGE_BACKUPS` 在生产里一次都没被读到。**

### 但跨账号兜底其实早就做了（round 13）

`smart-group.ts:591` 的 `accountFallback`（默认 true）：

  · 按 **host** 判账号（不是 endpoint+key——同域名不同 key 是同一个供应商）
  · `MIN_ACCOUNTS = 3`：链上不到 3 个账号就二筛
  · 二筛**只关延迟上限**，其余硬判据全保留
  · 注释写明"目标是 3 个账号，不是 2 个"——2 个里有一个坏的等于单账号

实测近 1h `Fallback label used = lfree` **111 次**——它确实在链上。
（lfree / mimo 都在 `ai.lfree.org`，算同一个 host；`dshkimi` 在
`api.kimi.com`——所以三个账号是 stepfun / lfree / kimi。）

### 所以还剩什么

23 次 exhausted 的成因不是"没有跨账号候选"，而是**三个账号同时在冷却**：
stepfun 被并发上限打满（RPM≈10）、lfree 中位延迟 15-19s 容易超时、
kimi 也在限流。`waitIfCooling` 等 15s 上界，等不来。

**我的 round 80 改动不是零价值**（测试判据对、.env.example 写清了、
auto-assign 关掉时手动链就是跨账号的），但它**没有解决我说它解决的那个问题**。
commit message 应该说清这一点——当时我没验生产就写了"修：加跨账号 backup"。

### 教训（第三次）

| 轮 | 我说修了什么 | 实际 |
|---|---|---|
| 54 | react 机制已接 | 只接了 legacy，生产走 Meta |
| 70 | maxTokens 写死清了 | 真闸在 provider.ts 的下限里 |
| **80** | judge 链加跨账号 backup | `.env` 手动链被 auto-assign 旁路 |

**共同点：改了配置/代码，没验证生产走的是哪条路。**

---

## 全链路巡检：四个子系统都健康，没有新 bug（round 82）

按用户第一句「各部分在不在正常工作」逐个过了一遍。

### 1. CodeAct 队列 — 健康

`CodeAct job failed` 60 次，但 **56 次挤在 09-21 一天**（同一个
`hasContract` 的 TypeError），09-23 只有 1 次且是 BullMQ 的老问题
`job stalled more than allowable limit`。形态像某次改动引入 + 后续修掉。

### 2. unified tick — 健康（9% 需重试，但重试兜住了）

`tick verdict unparseable, retrying` **1154 次 / 12766 tick = 9%**。
看着吓人，拆开：

| raw 形状 | 次数 |
|---|---|
| `''`（模型返回空） | 1093 |
| `` ```json\n{ `` 围栏 | 12 |
| `{"action": ...` 合法 JSON 但 parse 不出来 | 10 |
| `<｜DSML｜tool_calls>` DSL | 6 |

而 **attempt 分布全是 0**——即第一次失败、第二次成功，日志只在失败时打。
真正的损耗远小于 9%。各出口都有产出：

```
goal check dispatched 245 · vetoed by drive satiation 237
proactive rejected 20 · self-play 13 · cared for master 10 · spoke in group 2
```

`unified-tick.ts:746` 已有完整的重试 + 强化提示（round 26 建的）。
**够用，不用改。**

### 3. 心流 exhausted — 零头，且形状合理

`heart LLM failed` 143 次/天，占今天 1131 次 pass 的 11%。
按分钟拆：10:00-10:02 集中 20 次（3 分钟内），之后零星，10:25 后归零。

**尖峰和我的 restart 对不上**（restart 在 10:21/10:27）——
是 18:00 北京群聊真的密集触发的心流高峰。属容量问题不是 bug。

### 4. 前言不搭后语 — 产品层未复现（这次连分句也验了）

取今天全部 **147 条分句发送**（parts>=2，最容易暴露半句话），抽 12 条：
全部对得上，包括「啧」对「你故意的吧我靠～怎么只故意搞我」、
「刚复活就被撸下架了」对「刚复活咋没得？」。

### 结论

**没有新 bug。** 上一轮（round 81）记的"judge 链改动无效"是真问题但属第 3 档；
这一轮巡的四个都健康。

---

## 功能使用率盘点（round 84 的用户第三问：「有没有需要增添或者优化的」）

### 在用的功能

| 功能 | 全日志次数 | 状态 |
|---|---|---|
| Meta react（round 54 接上） | 34 决策 / 23 真发出 | ✅ 真的在用 |
| 心流 wait（第三态） | 24 决策 | ✅ 少但存在 |
| 代发别的 bot 命令 | 66 次（28 收到回执 / 24 答了） | ✅ |
| 撞名守卫（round 5） | **0 次触发** | ⚠️ 修好了但无法验证 |

撞名守卫 0 触发不是"没接上"（round 5 修它时确有两次误代发事故），
但**0 触发 = 无法证明它现在还能拦**。

### 代发的新疑点

66 次代发里 **38 次无回执**——和 round 55 查之前的形状一样。
而 round 55 加的"目标不在群"检查 **只有 fail-open 时走 debug**，
成功/挡住路径完全静默，于是分不清：

  挡掉了（guard 在工作）        → 不用管
  发了但没人接（bot 真不在群）  → 要修 guard
  没被调用（代码没接上）        → 要接线

**这个会话第四次犯同一个病**（round 75 截断重试走 debug /
round 77 sticker pick 返裸 null / round 78 reflection 无计数器）。

### 修：挡住时打 info + 计数器

```ts
logger.info({ chatId, bot, cmd }, 'delegation: target bot not in chat — blocked');
incrCounter('delegation_target_absent_total', { chat: chatId });
```

fail-open 仍是 debug（那个不需要吵）。

测试 5 条锁住：info 级、有计数、带 chat 维度、守卫本身还在、fail-open 不动。

---

## 加了观测点的 guard，1 分钟就证明了价值（round 86）

Round 84 我给代发的「目标不在群」守卫补了 `logger.info`，
理由写的是"0 触发 = 无法验证"。

**Round 85 部署后约 1 分钟，它真的挡住一次：**

```
chat=-1004430867819  bot=uzumaru_geoip_bot  cmd=/geo
```

而 `uzumaru_geoip_bot` 正是 round 55 那批（5/6 目标不在群）里的一个。
**说明它一直在反复被试，只是此前没有任何痕迹。**

### 这印证了本会话反复出现的那件事

| 轮 | 我说"没有数据" | 补了观测点后 |
|---|---|---|
| 75 | 截断重试 0 条日志 | 发现走 debug 被过滤（排了十二项才明白） |
| 77 | sticker 53 次空 fileId | 发现 pick 返裸 null |
| 78 | reflection 869 次全灭 | 发现和心流共账号 |
| 84 | 代发 guard 0 触发 | **1 分钟挡了一次** |

**"0 次"几乎从来不是"没问题"。** 这个会话里它每次都掩盖着别的东西。

### 顺带：403 长冷却的较长窗口

```
10:20-10:45（修复前 25 分钟）：16 次 = 38/h
10:45 后（修复后 12 分钟）：    2 次 = 10/h
```

降 74%，但 12 分钟样本禁结论。

---

## 这次"0 次"是真的 0——附怎么分辨的方法（round 87）

Round 84 我说「撞名守卫 0 触发 = 无法验证」，round 87 给它补了 info + 计数。
部署后仍是 0 次。但**这次能证明是真的 0**：

### 证据链

```
jev 快路径今天跑了 1544 次          ← 不是没调用
  全部是 "jev → 无命令"（Jev 判"不借"）
历史累计 125 次 "jev matched command"，命中的是：
  /re (52) /geo (34) /model (11) /waifu (6) /get (5) /jx (4)
OWN_COMMANDS 是另外 13 条（/checkin /help /status /stats /muteme ...）
  → 6 个命中命令**没有一个**在自己的清单里
  → 判据 OWN_COMMANDS.has(cmd) 全部 false
  → 守卫正确地不触发
```

### 和"看不见"的区别

| | 看不见（round 84 代发 guard） | 真的 0（round 87 撞名守卫） |
|---|---|---|
| 观测点 | 只有 debug 日志 | 补了 info + 计数 |
| 调用面 | 部署后 1 分钟挡了 1 次 | 1544 次调用、命令清单对得上 |
| 判据 | 命中 → 挡住 | 命中集合与判据集合无交集 → 正确地不动作 |

### 方法（这才是可复用的部分）

"0 次"要证真，需要三样：

1. **观测点**（不是 debug）—— 否则看不见
2. **调用面**（这条路今天被走了多少次）—— 否则不知道有没有素材
3. **判据的输入集合**（什么样的输入会让它动作）—— 否则不知道判据对不对

三样齐了才能说"真的 0"。缺一样就是 round 84 那个状态。

### 顺带

用 round 85 的动态日志级别开 debug 看了一眼 command-router——
**没有日志**，直接证明它没进快路径的后续。这就是那个工具的价值：
不用改 `.env` + 重启，一条 redis 命令就能现场看。

---

## 抓到现行：同一条消息被回 4 次，跨 7 分钟（round 88）

用户抱怨"前言不搭后语 + 重复回复"。逐条量发送记录时抓到一组：

```
10:53:13  rp=13862  '不然呢，不然本喵怎么看得懂那些缩写喵'   ← 第 1 次（正常）
10:56:51  rp=13862  '不然本喵怎么知道 CN 是中国喵'           ← 第 2 次（3 分钟后）
10:59:52  rp=13862  '本喵是啾咪，不跟莹抢DeepSeekV4F的名号'   ← 第 3 次（跑题）
11:00:18  rp=None   '本喵不是DeepSeekV4F，本喵是啾咪喵'       ← 第 4 次
```

### 记了账，但没人读账来拦

Redis 里 `xxb:meta:answered:-1004430867819:13862` 的值是
**5 个时间戳**（10:56:52 / 10:59:52 / 10:59:54 / 11:00:10 / 11:00:19）——
`markMessageAnswered` 每次都往里加一个，工作正常。

但 `answeredTimestamps` 只在 **Heart decision** 时注入 prompt
（"这条你已经回过 N 次"）——**那是提示，不是闸**。
模型看到提示仍然回了。

而 5 次发送里只有 **1 次**经过心流（`Heart decision` 日志提到 13862 的只有 1 条）。
其余 4 次走的是 subagent / CodeAct / self-continue —— 那些路径
**压根不读 answered 账本**。

### 和既有修复的关系

| 轮 | 修了什么 | 覆盖面 |
|---|---|---|
| 1 | `repliedAnchors` 去重 | 只挡**同任务内** |
| 65 | 前缀去重（同群同文本 30s） | 挡"同一句话"，这里四句都不是同文本 |
| 52 | 发送出口 `markMessageAnswered` | 只**记**，不拦 |

三次修的是三个不同形状，而这个形状（**跨任务、跨 7 分钟、同一锚点、不同文本**）
一次都没被挡过。

### 这是个真缺口

`xxb:meta:answered` 有 4583 个键、每条最多存 5 个时间戳——
数据一直在，但读者只有心流的 prompt 注入。**需要在发送出口当闸用**：
同一锚点在 N 分钟内被标过 M 次 → 拦下或合并。

---

## 重复锚点闸：判据直接验过，位置覆盖 100% 发送路径（round 91）

### 判据的边界（不等生产样本，直接单测验了 5 个 case）

```
[]                        → 放行（没回过的）
[60s 前]                  → 放行（才 1 次）
[60s 前, 120s 前]         → 拦（窗口内 2 次）
[600s 前, 60s 前]         → 放行（一次在窗口外，只算 1）
[170/120/60s 前]          → 拦
```

窗口边界用 `<=` 而不是 `<`（刚好 180s 算窗口内）——这两个都锁在测试里。

### 位置覆盖 100%

生产发送日志只有一类：`host sendText`（5554 条 + 923 continuation），
`deliver.ts:1095` 那条 legacy 路径**没有任何发送日志**。
所以闸挂在 `host-api.ts` 就覆盖了全部出口。

### 生产样本要等"不再发生的事"

修复前 1 小时：42 条带锚 / **4 组重复（9.5%）**。
部署后 1 分钟 0 条——没样本。

而这个闸的"成功"恰恰表现为**样本消失**：它拦住时打 warn，
但更常见的是模型看到 throw 的文案后换内容/让这条过去，
那就连 warn 都没有。

**这类修复的验收不能靠"计数下降"，只能靠判据测试 + 位置确认。**
（同 round 87 的撞名守卫：证"真的 0"需要三样——观测点、调用面、判据输入集合。）

---

## 差点又报一个没有分母的 0（round 92）

### 我以为是缺口，其实早覆盖了

这轮想"把 measure 的 ③ 从同文本扩到同锚点"，查下去发现
`scripts/measure-voice.mts:117-120` **早就在数锚点维度**：

```ts
const a = d.replyTo;
if (typeof a === 'number' && a > 0) {
  const k = `${d.chatId}:${a}`;
  anchor.set(k, (anchor.get(k) ?? 0) + 1);
}
```

而输出行一直是：

  ③ 重复回复率      3.7%   多出 26 / 首气泡 698
     同一锚点被回 >1 次的: 25 个；最惨的被回 3 次。

**round 60 我建它时以为只是同文本判据，其实锚点维度更宽。**
"没查就下结论"这个会话犯了太多次——这次是在动手前多查了一步。

### 然后差点又犯"没有分母的 0"

拿 deploy 前后对比：

```
11:21 部署前：24 组重复锚点（共 49 条发送）
11:21 部署后： 0 组重复锚点（共  0 条发送）   ← 看着像修好了
```

但分母一数就穿了：

```
部署前带锚发送 343 条 · 部署后 3 条
WARN: 部署后样本 <20 —— 0 组重复不算证据
```

**部署后只发过 3 条带锚消息。** 0 组重复是必然的，与闸无关。

这正是我 round 31 给 `compare` 写的禁结论判据（载荷差 >25% 或任一面板
零流量就不许下结论），自己单跑时差点又犯。

### 结论（诚实版）

round 89/90/91 的重复锚点闸：

| 维度 | 状态 |
|---|---|
| 判据正确性 | ✅ 5 个边界 case 单测验过 |
| 位置覆盖面 | ✅ 生产发送 100% 走 host-api |
| **生产效果** | ⏳ **未验**（部署后仅 3 条带锚样本） |

要等今晚 cron 或群聊恢复。基线记在这里：**部署前 7.0%（343 条里 24 组）**。

---

## react 的 11 个"没发出"是我口径错了 + 1 个真缺口（round 94）

### 表面

`Meta heart: reacted` 24 次，而 `Heart decision act=react` 35 个。差 11 个。

### 查下去

35 个 react 决策**全部 `emoji=(none)`**——模型输出 act=react 但不给 emoji。
我 round 54 的代码会随机挑一个（`heart.emoji ?? pickReactionEmoji('neutral')`），
所以应该能发。

逐个对时间戳，那 11 个"没对应发送"的分布在 01:21-08:51。
看 01:21:04 那条附近：

```
01:21:04  Heart decision why=这贴纸就是我现在的状态
01:21:04  Meta heart: reply → Attention        ← adapter 译成 reply 了
01:21:04  Meta attention ingested (heart)
01:21:07  Meta dispatch.taskToGroup
01:21:07  CodeAct task start
```

**`act=react` 在 Meta 侧被译成了 `reply → Attention`。**
即那一波根本不是 react 发送路径，是 reply 路径。

所以"35 vs 24 差 11"这个数本身就是**混了两个口径**：
`Heart decision`（decision.ts 打的，两条路径共用）
vs `Meta heart: reacted`（只在 Meta 的 react 分支打）。

### 真缺口：react 分支的失败只有 debug 日志

`src/meta/heart-adapter.ts:264`：

```ts
logger.debug({ chatId, emoji }, 'Meta heart: react not delivered, falling through');
```

这是本会话**第 5 处**"防问题的机制只有 debug 日志"：
round 75（截断重试）/ 77（sticker pick）/ 78（reflection 计数器）/
84（代发 guard）/ 87（撞名守卫）+ 这一处。

它 0 次触发——但和非法的 0 一样，** debug 级看不见**。

### 教训

"两个数不相等"就想找差异，是我第 N 次**没先确认两个数同口径**。
round 48 的量具教训（heart-answered-recall 测试的注释写着
"different shapes for the same flow"）说的就是这件事。

---

## 全天稳态 + 又混一次口径（round 95）

### 全天（19:40 北京）

```
① 回复率 19.4%（09-22 全天 15.2%）
② reply 14% · react 2% · wait 0% · pass 86%   n=1466
③ 重复率 3.7% · 同锚点被回 >1 次 25 个（最惨 3 次）
④ 撞名守卫 0 次
⑤ 到心流 1466 · 被闸咽 239 · 空正文 384（都含修复前的累计）
```

各群条/小时：-1004451430063 14.9 · -1003821093564 12.3 ·
-1003543275052 8.9 · -1004430867819 8.4 —— 都比 09-22 的同群数低。

### 又混一次口径

部署 20 分钟窗口：带锚发送 5 条（全天累计 348）→ 我差点判"它现在几乎不引用"。

按小时一看就打脸：

```
00h 36 sendText / 16 带锚 = 44%     06h 58/26 = 45%
01h 62/37 = 60%                     07h 81/33 = 41%
02h 69/29 = 42%                     08h 41/30 = 73%
03h 71/29 = 41%                     09h 91/46 = 51%
04h 47/20 = 43%                     10h 98/63 = 64%
05h 26/10 = 38%                     11h 21/10 = 48%（整小时）
```

**全天带锚率 ~50%，与 prompt 的"该引才引"一致。** 我拿"部署后 20 分钟"
和"全天累计"比——第 N 次口径不一致（round 48 量具教训、round 94 react 决策
vs 发送，都是这个）。

### 25 组重复锚点按群

```
-1003821093564    8 组（16 条发送）  ← 最集中
-1004430867819   5 组（11 条）
-1004451430063   3 组（6 条）
其余 6 个群各 1-2 组
```

最集中的群也是条/小时最高的之一（12.3）——重复锚点和群活跃度相关，
不是某个群的病。

---

## 发现第二套 skill 系统（round 96）

用户第三问「有没有需要增添的功能」。盘点 skill 生态时发现：

**仓里有两套互不通的 "skill"：**

| | A. `skills/*.json` | B. DB `skills` 表 |
|---|---|---|
| 形态 | HTTP 工具定义 | 蒸馏出来的对话技巧 |
| 字段 | url/method/params | trigger_when / steps / pitfalls / tags |
| 数量 | 7 | 20 |
| 谁能加 | 用户（PR） | 系统自己（从经验蒸馏） |
| 我做的生态 | round 39-40 全在这个上面 | **从没看过** |

### B 的健康度（第一次看）

```
big   4 个 · 0 归档 · 用了 3198 次   ← 主力
small 16 个 · 16 全归档 · 用了 63 次  ← 被大 skill 回收
```

形态是健康的：小的被合并成大的（防碎片），大的在被用。4 个主力：

```
人设群聊接梗     1631 次   收到闲聊调侃质疑、技术求助、动作互动
角色语气适配     1437 次   用户要求特定语气
承诺跟踪         106 次    跟进承诺事项
社群互动与交付    24 次    被质疑规则、吐槽随机结果
```

**这解释了"它为什么像个人"**——3198 次经验里蒸馏出的接梗技巧，
比 prompt 里的静态规则更接近真实语感。

### 没做的

A（JSON 生态）我做了文档+7 示例+动态列表；
B（蒸馏技巧）我一次没碰，因为不知道它存在。

这和 round 39/57 一样：**生态不止一个，我先做了我知道的那个。**

---

## 蒸馏 skill 的 helpfulness 信号恒为 0（round 97）

Round 96 报"4 个 big skill 用了 3198 次"。但那只是 `use_count`——
而 `src/agent/skills.ts:78` 的注释明写：

> Retrieval counts (use_count) measure recall, not helpfulness — never conflate the two.

### 更严的那个信号是空的

```
人设群聊接梗  use_count 1632  verified_use_count 0
角色语气适配  use_count 1438  verified_use_count 0
承诺跟踪      use_count  106  verified_use_count 0
社群互动与交付 use_count   24  verified_use_count 0
```

### 链条逐段查（这次没漏）

```
findRelevantSkills(prompt-inputs.ts:216)  → ids
  → injectedSkillIds(executor.ts:476)
  → recordSkillVerifiedUse(executor.ts:1110)
      只写库 if evidence === 'verified'
```

两个 flag 都开着（`EXPERIENCE_VERIFY_ENABLED=true` /
`SKILL_VERIFIED_USE_ENABLED=1`），但**日志里 assessment status
从来没出现过 `verified`**：

```
done 3211 · failed 370 · queued 144 · unverified 6
waiting_user 5 · administrator 2 · verified 0
```

而能产出 `'verified'` 的是 `src/eval/agi-like-evaluator.ts:16`
（`EvaluationStatus = 'verified' | 'failed' | 'unverified' | 'blocked'`）——
**而它在 src/ 里没有任何调用者。**

### 结论

不是接错线，是**上游根本没跑**。所以：

  · "哪些技巧真的有用" 这个信号从系统上线就是空的
  · 淘汰只能靠 use_count（recall），而注释自己说那不等于 helpfulness
  · round 96 我报的"3198 次使用"是 recall，**我用它撑不起"它为什么像个人"那个结论**

（这不影响运行——skill 照常注入照常用。只是它的自优化少了一个输入。）

---

## verified=0 不是 bug，是**设计如此**（round 98 修正 round 97）

Round 97 我说"能产出 verified 的 agi-like-evaluator 在 src/ 里没有调用者，
所以上游根本没跑"。**那是不对的。**

### 真相（task-evidence.ts:78-80）

```ts
// 模型自评不算数，设计如此！
return { status: contract.source === 'caller' ? 'verified' : 'unverified',
  reasons: [contract.source === 'caller' ? 'caller_checks_passed'
                                        : 'model_checks_not_independent'], checks };
```

**`'verified'` 只在 contract 来自 `caller`（宿主/外部给定）时产出。**
模型自己 `propose()` 的检查永远得 `unverified`——理由写在代码里：
`model_checks_not_independent`。

而群聊里 bot 的回复**没有 caller 契约**（没有外部验收方），
所以 status 恒 unverified —— **这是正确的行为，不是缺了一根线**。

### 我 round 97 错在哪

把它当"断线"查，是因为看到"计数器 0 + 有个能产出该值的模块没被调用"。
但那个模块（`agi-like-evaluator`）是**离线 A/B 评测 harness**，
文件头原话：

  Offline paired replay evaluator. This is an engineering harness,
  not a model benchmark: the caller owns the executor and acceptance contract.

它和运行时的 `task.assessment` 共用 `'verified'` 这个枚举值，但**是两件事**。
我把它当成运行时验收的提供者了。

### 正确的结论（缩小版）

Round 97 的观察仍然成立：`verified_use_count` 全是 0。
但它**不是"信号断了"**，而是"群聊场景下不可能有独立验收"。

含义也变了：
  · 技能库的 helpfulness 不会从群聊任务里自动长出来
  · 想让它长，需要**外部**验收（主人 / 群管 / 规则）——那是功能不是修 bug
  · 我 round 97 说的"系统上线就是空的"仍对，但"上游没跑"是错的归因

### 教训

看到一个"没人调用的产出者"就判定"上游没跑"——我又犯了。
**先问：这个产出者是给谁用的？** 那一条能省一整轮。

---

## helpfulness 的外部信号已经有，只是没接到 skill 上（round 99）

Round 98 的结论是"群聊不可能有独立验收，helpfulness 长不出来"。
这轮查下去发现**那句话只对了一半**。

### 已经有的外部信号（`src/tracking/outcome.ts:190-215`）

```
explicit_positive  → outcome 'reacted'   y=0.5（回声）
explicit_negative  → outcome 'corrected' y=-0.5
user_replied       → outcome 'replied'   y=1.0
ignored_*          → outcome 'ignored'   y=0
```

它靠**行为信号**识别好评/差评，而且已经接了三处消费者：

  · `closeSelfActOutcome` → self-history（模型看到"这条被纠正了"）
  · `settleEcho(chatId, y)` → 回声调参（E 值）
  · `feedback-aggregate.ts` → pos/neg 汇总

**即：外部验收信号存在，且已在驱动别的东西。**

### 缺口（缩小）

`recordSkillVerifiedUse` 只认 `'verified'`（caller 契约），
而这些行为信号（explicit_positive 等）**没有一条通向 skill 的
`verified_use_count`**。

所以 round 98 说的"需要外部验收"其实已经有了——
差的只是**把它接到 skill 计数器上**。

### 但要不要接，是个设计决定

接上的话：
  · 好处：skill 淘汰从"只用 recall"变成"也用实际反馈"
  · 代价：`explicit_positive` 的判据是"下一条消息带正面词"，
    那可能是对**别人**说的，不一定是夸 bot 这条回复
    （判据精度未知，没量过）

所以这不在我能单方面做的范围内——**它改的是"什么算 skill 有效"的语义**。

---

## 「 replied 率」从来没改善过 —— 我 40 轮修的都是另一件事（round 100）

### 量具的意外发现

量「bot 说完话后 3 分钟内它自己 pass 了多少」（ignore → 收敛）时，
顺手看了 self-act 的 outcome：

```
-1004430867819  12h 50 条：replied  3( 6%)  ignored 38(76%)  corrected 0
-1003821093564   12h 50 条：replied  1( 2%)  ignored 37(74%)  corrected 2
-1003543275052   12h 50 条：replied  3( 6%)  ignored 40(80%)  corrected 0
```

而 `getSelfActSummary` 取最近 50 条。**replied 一直是 2-6%**，
round 60 那个 17% 是更早窗口的数。

### 这意味着什么

我这 42 轮修的东西：

| 修的 | 影响面 |
|---|---|
| why 脏 JSON / 前缀去重 / 重复锚点闸 | 让它**说得对** |
| trench 闸 30s→8s、分片只过一次闸 | 让它**说得出** |
| maxTokens 下限 / 账号隔离 / 403 冷却 | 让它**不哑** |

**没有一件是「说完之后怎么让人接」。** 而 replied 2-6% × 24 个群，
就是用户说的「很难融入话题」的**最终形态**——它说的话技术上正确、
时机也对、也发出去了，但群里人不接。

### 那 6% 有人接的长什么样

```
反手刀？要翻盘啊喵          确实该打喵
90+60啥玩意，谁又惹你了      惨喵，算账算到一半余额先没了
牛來你这是抽卡沉船了还是被金发姐姐拒了，哭成这样
没事，就是来看看你抽卡抽傻了没
她刚才刷屏十八条贴纸，瞎啊？   光头还能成神，这设定挺省洗发水喵
```

共同点：**点名具体的人 + 一个可回的钩子**（问句、吐槽、可争议的判断）。
而 94% 被 ignore 的没有这个形状。

**这不是我能在代码里单方面改的**（改的是"怎么说话"的语义，不是 bug）。
但它是这 42 轮里第一个**直接量化到用户原话**的数字。

---

## round 100 的假设是假的：我亲手验崩了它（round 101）

Round 100 我说「有人接的共同点：点名具体的人 + 可回的钩子」。
当时只看了 14 个成功样本——**典型的选择偏差**。

这轮用全天 354 条有锚回复验：

```
             有人接(181)   没人接(173)
点名+钩子      7 (4%)        6 (3%)      ← 无差别
长度 median     11           12         ← 无差别
```

**两个假设都不成立。** 从 14 个样本归纳的"规律"是假的。

### 同类错，发现得越来越快

| 轮 | 错误归纳 | 隔了多少轮才发现 |
|---|---|---|
| 17 | 占比而非节奏（17 轮改错方向） | 17 轮 |
| 14 | 睡眠相当空闲（6 轮空转） | 6 轮 |
| 61 | 12 次 pass 当同质 | 1 轮 |
| 100 | "点名+钩子"是融入口诀 | **1 轮（自己验崩）** |

### 剩下的真实数字

replied 2-6%、ignored 74-80% 仍然成立（self-act 稳态统计）。
**变的只是"我知道为什么"变成了"我不知道"**——而后者比错解释更有价值。

---

## replied 那两个数差 25 倍，而我看错了 3 轮（round 103）

### 触发

Round 102 建了 measure:engage。这轮想看"为什么群与群差 10 倍"
（最好 18% vs 最差 2%），逐条对比两个群时发现：

```
-1002450361141  sends 19  真人接 9   = 47%
-1003821093564  sends 81  真人接 40  = 49%
-1004451430063  sends 65  真人接 41  = 63%
```

而 self-act 报这三个群是 18% / 2% / 2%。

### 差在哪

`src/tracking/outcome.ts:19,310`：

```ts
const OUTCOME_CHECK_WINDOW = 5;      // 条人类消息
const OUTCOME_MAX_WAIT_SEC = 600;    // 10 分钟

if (msgsAfter >= OUTCOME_CHECK_WINDOW || waitedLongEnough) {
  signal = `ignored_${OUTCOME_CHECK_WINDOW}_msgs`;   // ← ignored
}
```

**ignored 的判据是"发完后群里出现 5 条人类消息还没人接"。**
在活跃群（每小时 80+ 条），5 条约等于 3-4 分钟。

| 判据 | 度量什么 | 数字 |
|---|---|---|
| self-act replied | 5 条人类消息内有人接（约 3-4 分钟窗口） | 2-6% |
| 30s 判据 | 30 秒内有人接 | 47-63% |

**两者都对，度量不同的东西。** self-act 那个是"慢热融不进去"，
不是"没人理"。

### 我错了 3 轮

round 100 报 replied 2-6% 当"融入失败"、round 101 验崩"点名+钩子"、
round 102 验崩"小群更容易"——三次都在解释一个**度量口径不同的数**。

---

## 三个窗口快接率：30s 51% / 5min 84% / 10min 89%（round 104）

Round 103 发现 self-act 的口径是「5 条人类消息内有人接」（活跃群 ≈3-4 分钟）。
这轮把秒级的也算出来：

```
           有人接     比例
30 秒内     183/357    51%
5 分钟内    299/357    84%
10 分钟内   318/357    89%
```

### 这改写了对「很难融入话题」的判断

```
它说的话最终有人接    89%
其中一半要等 30 秒以上  （49%）
```

**所以问题不是「没人理」，是延迟。** 而用户 round 62 的原话：

> bot 反应 10-16 秒…中间可能隔了好几个人的话，显得 bot 说话迟钝、
> 前言不搭后语，原本没带 replyto 的可能又要带上

那正是这 49%——它的话没被无视，但话题已经翻篇了。
而这跟 round 62 我做的 replyto 兜底是**同一件事的两半**：
带上锚点让人看出在回谁，但**带得晚**照样像插话。

### measure:engage 已经把这个口径差写进输出

```
基线：09-22 全天 15-18%，09-23 全天 2-6%（口径见 round 100）。
   ⚠️ 那 2-6% 是「5 条人类消息内有人接」的口径（活跃群约 3-4 分钟），
      不是「没人理」。同一天扫日志算秒级：30s 51% / 5min 84% / 10min 89%
      （round 103/104）。三个数都要看。
```

**以后再有人（包括我）看到 2-6%，不会再讲错故事。**

---

## 延迟的三段账（round 105）

Round 104 诊断"难融入"是延迟。这轮把延迟拆开：

```
消息到达 → 心流决策    median 11.3s  p90 23.2s   （心流 LLM 5.4s）
心流决策 → 发送        median 19.4s  p90 42.3s
CodeAct 任务全程       median 29.4s  p90 86.2s   （全日志 3728 个任务）
```

### 对应到快接率

```
30 秒内有人接  51%
5  分钟内      84%
```

**要把 30s 快接从 51% 提到 80%，总延迟得压到 20s 以内。**
两段各 11-19s，都有空间，但第二段的 p90（42s）是长尾主因。

### 没做的

这不是能单方面改的：压延迟要么减少 LLM 调用（改判据语义），
要么加并发（提高限流风险，而三个账号都在被限流——round 83 那个）。
**属第 3 档。**

但这三轮把"很难融入话题"从一句抱怨变成了：

| 轮 | 得到什么 |
|---|---|
| 103 | 2-6% 是"5 条内没人接"的口径，不是"没人理" |
| 104 | 30s 51% / 5min 84% / 10min 89% —— 是延迟 |
| **105** | **延迟三段的账：11.3s + 19.4s，p90 在第二段** |

---

## 长尾的形状：45% 30s 内、36% 30-60s、19% >60s（round 106）

Round 105 说 p90 42s 在第二段。这轮拆 CodeAct 任务时长分布：

```
<10s  237 | 10-30s 1666 | 30-60s 1108 | 60-120s 504 | >120s 213
（n=3728 全日志）

45% 在 30 秒内
36% 在 30-60 秒    ← 拖慢接率的主因
19% 超过 60 秒
```

最慢的两个（992s / 952s）是 selfplay / 长任务——不是回复群聊的。

### 没有卡死的任务

`CodeAct host code timed out` 只有 39 次，而 3216 done / 370 failed。
**所以那 19% 不是卡住，是真的在做 60 秒以上的事。**

### 结论（对话接的延迟）

要把 30s 快接从 51% 提到 80%，得让第二段从 19.4s 降到 ~10s。
而 36% 的任务在 30-60s——压那段要么：

  1. 群聊回复走**快路径**（不等完整 CodeAct 任务）
  2. 降低任务的 turn 数上限

(1) 是设计问题（那个 30-60s 的任务可能真在查东西）；
(2) 会砍能力。**都属第 3 档。**

### 但这轮排除了一个可能

我原本猜"是不是有任务卡死拖慢整体"——查完没有。
019% 是真实工作量，不是死锁。

---

## 反广告现在空转：49 个指纹在采，但 0 个群授权（round 109）

用户第一句「各部分在不在正常工作」。巡到反广告层：

```
xxb:trench:antiad:fp:*    49 个   ← 采集中
xxb:trench:antiad:on:*     0 个   ← 没有群授权
xxb:trench:antiad:win:*    0 个   ← 没有窗口
```

**采了不用。** 而 `.env` 里 `ANTIAD_CHAT_IDS` 没配（只有注释提到它）。

顺带确认这不是泄漏/失控：
  · 指纹键有 TTL（6 小时，`ad-pressure.ts:141-142`）
  · 只存行为计数 + 内容指纹，**不存原文**
  · 49 个 × 6 小时自动清，不会无限堆积

### 为什么现在才发现

Round 62 我记的是「反广告 live in 2 authorized groups」——那是当天的状态。
授权是**群主动态开/关**的（`setAntiAd`），没有审计日志——
`antiad command applied` 全日志 0 次，所以那两个群从没打过开关命令，
授权是别的方式写进去的（或我 round 62 记错了）。

**教训**：动态授权没有日志，我说"live in 2 groups"却没有任何痕迹支撑。
（第 N 次"报了个没有观测撑着的事实"。）

### 这不是 bug

没授权就不该用广告压力——这是正确行为。
但它意味着「反广告」这个功能目前对生产零影响，而它的采集在消耗 Redis 写。

---

## 按天切分母后，round 89 的闸第一次拿到干净证据（round 112）

Round 111 的 `gate:evidence` 分母是全累计（2525 条）——虚高，因为
四个闸里三个是这几轮加的，修复前的样本混在分母里。

改按 UTC 今天切（和 `measure:voice --day` 同口径）。然后立刻能读：

```
repeat groups before deploy (11:21): 24
repeat groups after  deploy:          0
anchored sends after deploy:         16
```

**24 组全在部署前，部署后 0 组。** 而闸拦住 0 次——
两个数一致（没有重复发生，闸没机会拦）。

这才是干净的证据：口径对了之后，我知道：
  · 分母 16 条带锚（<20，仍禁强结论）
  · 但那 16 条里 0 组重复，而部署前同样长的窗口有 24 组

**round 92/95 我纠结两次的"0 组算不算数"，根因是分母从来没按天切过。**

---

## ③④ 的 0 是场景稀有，不是没接上（round 113）

Round 112 的干净口径出来后，③④ 两个闸的 0 也能解释了。量了判据场景频率：

### ③ 人在纠正止损

```
今天人类入站  4,447 条
含纠正词的        4 条（0.1%）
```

全天最多触发 4 次（还要满足"冲着 bot 来"）。实测 0 次——
**场景本身稀有**，不是"看不见"或"没接上"。

### ④ 同群同文本 30s 去重

```
今天 sendText 717 条
同群同文本 30s 内的对：25 对
  其中 11:21 部署前：25
       部署后：0
```

**25 对全在部署前，部署后 0 对。** 和 ① 一样干净。

### 四个闸现在都有说法

| 闸 | 状态 | 证据 |
|---|---|---|
| ① 重复锚点 | 部署后 0 组（前 24） | clean |
| ② 代发目标不在群 | 真在挡 2 次 | 生产验证（round 86） |
| ③ 人在纠正 | 场景稀有（0.1% 入站） | 判据覆盖率 |
| ④ 同文本去重 | 部署后 0 对（前 25） | clean |

**"0 次"的三种可能我现在能分开：**
真没有 / 判据正确地不动作 / 看不见。
而 ①②④ 是"部署后真的没有"，③ 是"场景稀有"——都不是 bug。
