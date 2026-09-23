# 修「不会用别的 bot」+「说话太应激」的实施计划

状态：**原计划可做的全做完；等数据的期间又挖出并修了六个更重的问题**（见文末「round 200 补记」）

---

## 全门禁实测基线（round 40 逐项跑过，非推算）

```
typecheck           0 error
lint                0
test                522 文件 / 4064 过 / 4 skip
build               ok
verify-deploy       87/87
verify-integration  41/41
service             active
health              200
git                 干净、0 未推送
```

> 这些数**每轮都重跑**，不承前提。round 38/39 归档过：命令超时就读不到输出，
> 那时写「没验」，不要按「上轮 + 我加了几条」推算（我那样错过，把 87 报成 107）。

---

## ⚠️ 读一个 0 之前的四步（round 41/42 + 191/196/201 的汇总）

今天修的六个东西，在生产日志里**全是 0**。0 有三种完全不同的原因，
修法相反，所以先分类再动：

| # | 问 | 如果是这个 | 怎么办 |
|---|---|---|---|
| 1 | 回放判据，场景发生过吗？ | 发生过而计数是 0 | 修闸或它的可观测性（round 191/201 真抓到两个） |
| 2 | 判据的状态源在哪？ | **进程内** | 全日志回放无效，别据此否证（round 41/42） |
| 3 | 上游闸拦了多少？ | 上游拦掉大半 | 数量小是设计如此，别当 bug（round 37 闸①） |
| 4 | **状态活得过去吗？** | **每次重启清零** | 闸是瞎的——要等一个不重启的周期（round 42） |

第 4 步是今天多数 0 的原因：我为部署重启了十几次，
`recentBotTextsByChat`（进程内 Map）每次清零，所以 topic-word / burst / 缺参 /
账本打点这些闸**从没被给过机会**。

**所以：round 198/201/38 的生产效果，要等一个「部署后不再重启」的 awake 周期才能验。
在那之前日志里的 0 一律读作「没机会」，不是「没生效」。**

---

## ⚠️ 原计划剩两件，都等生产数据

**① taskId 到位了 —— round 190 已验**（18:33 UTC 第一条带 `taskId` 的 `host sendText`，
全链路 `dispatch → task start → sendText → delivery recorded → done`）。
②③④ 见下面每项的「怎么看」。

目前（2026-09-24 01:50 CST）群在睡，最后一次 `host sendText` 是
**15:09 UTC，而 round 170 加的 `taskId` 字段那一后才生效**，
所以目前一条都没有。下面每条都写了怎么看。

### 群醒了以后，按这个顺序查

**① taskId 到位了吗（k3 Step 0.5，一切的前置）**

\`\`\`bash
grep '"host sendText"' logs/app.log | grep -c taskId      # 应该超过 0
grep '"host sendText"' logs/app.log | tail -1 | cut -c1-160 # 看字段真的在
\`\`\`

为 0 或很低 → 后面全部白做（gap 闸和密度判据在生产都等于没装，
因为只有 `executor.ts:420` 这一条主路径带 taskId）。

**② interrupt 分桶**（round 177 上线的观测）

\`\`\`bash
curl -s --noproxy '*' http://127.0.0.1:3001/metrics | grep agent_interrupt
\`\`\`

`background` 占比高 → (b) 真分级值得做；`addressed` 占比高 → incident 的 3 条闲聊
是例外，分级效果有限，别做。

**③ burst 闸到底地地地弹了多少（k3 Step 1/2 的依据）**

\`\`\`bash
npx tsx scripts/session-report.mts 3 | grep -A2 '每任务开口次数'
\`\`\`

“超过 2 次开口的" 那个数字就是密度判据（`气泡数 > 3 且 开口 >= 2`）
该治的批次。为 0 → 别做密度判据（没病）；很多 → 做。

**④ incident 回放测试**（k3 说这才是"拦到了"的定义，其余都只是间接证据）
需要先有密度判据才能写。在 `tests/unit/subagent/` 下，
按日志时间线 :32/:34/:36/:47/:49 依次喂给同一个 taskId，
断言第 4 个抛失、计数器 +1、`sendMessage` 只调 3 次。

### 不要在没数据时做的事

· 不要调 `TASK_BURST_GAP_SEC` —— k3 已经判定 gap 这个轴本身就是错的
  （12s 拢不到 15.1s 的 incident；16s 换 31-41% 误吐 + 0.9s 裙度，而且拦不住模型重发）
· 不要上密度判据—— k3 明确说它有一个已知假阳性形状
  （"先一句短确认 + 再一次完整作答"，合计 4 气泡 / 2 开口），允许不允免要
  等线上分布，**别现在猜**
· 不要把 `NYATOS_BUDGET_MIN_GAP_ADDRESSED_SEC` 从 8 往上调——30s 是 round 68
  按用户"33% 被吐回去"否决过的值

---

## 现场（唯一事实来源）
起因：用户 2026-09-23 23:05 现场报的两个抱怨
评审：k3 subagent 出过一轮，本计划吸收了它的结论并逐条复核过

---

## 一、现场（唯一事实来源）

群 `-1003184176508`，2026-09-23 15:05 UTC（23:05 CST）：

```
15:05:10 IN  global-warp有无搞头
15:05:16 IN  3U 预计100地区                                    ← 没 @ 没回复
15:05:20 Delegation: command sent → bot=uzumaru_geoip_bot cmd=/geo   ← 无参数
15:05:22 IN  Please provide an IP or domain / Usage: /geo IP_or_domain
15:05:34 IN  sb
15:05:35 agent: message routed to running long task as interrupt
15:05:37 OUT 笨死了                                             ← 任务回 interrupt
15:05:40 OUT /geo 8.8.8.8                                      ← 当聊天内容直发，绕过全部委派闸
15:05:39 Heart decision → reply → Attention                     ← 心流又回一次（竞态）
15:05:58 OUT ？
15:06:12 OUT 骂谁呢
15:06:15/24/26/28 OUT 鸡肋，也就，Netflix 能用 / 搞头不大 / 中继稳但延迟高 / 看流媒体凑合…
```

**同一个任务 51 秒发了 11 个气泡**（4 次 sendText × 分片 ≤3）。
**同一条 `sb` 被两个路径各答一遍**（任务的 interrupt 15:05:37 + 心流 15:05:39）。

## 二、根因（已核实）

| # | 根因 | 证据 |
|---|---|---|
| R1 | 命令路由的触发前提被丢掉：`ingress-intercepts.ts:111` 只要求 `text.length >= 3 && !isBot`，**不要求寻址**。注释自己写着"没被寻址时也试一次" | 代码原话 |
| R2 | usage 回执被当查询结果解：`bot-delegation.ts` 的 `answerFromDelegation` 把对端文本包成"它回的结果是：…Usage: /geo IP_or_domain"，并指示模型"结果用不上或为空就说没查到" | 代码 |
| R3 | `/geo 8.8.8.8` 走无闸路径：当**聊天内容**从 `host sendText continuation` 直发，绕过全部委派闸。`maybeRegisterTypedDelegation` 只接在 legacy `deliver.ts:1284` | 日志 preview=/geo 8.8.8.8 |
| R4 | 同一条回执被双重消费：attention L0 派了任务，bookkeeping 的回执处理器又答一次（fire-and-forget，竞态） | R1 的代码 + 现场两条回复 |
| R5 | 刹车片比注释说的薄 4 倍：`NYATOS_BUDGET_MIN_GAP_ADDRESSED_SEC` 注释写 30s，`.env:884` 实际 **8s**，`life.ts:136` 默认也是 8 | grep 实证 |
| R6 | 任务被 interrupt 吊着连发：4 次 sendText 的 anchor 全带 `defaultReplyTo` → 恒 `isAddressed=true` → 豁免 90s 主动间隔，只剩 8s 被叫间隔 | `.env` + 现场 |

## 三、不做的（明确拒绝）

| 方案 | 为什么不做的 |
|---|---|
| B1「纯骂不进心流」原形 | `evaluateRules` 唯一调用方是 `judge.ts`（legacy，生产 <3%）；且现场"笨死了"根本不是心流出的，是任务回 interrupt。写在 rules.ts = 死代码 |
| B2「`*` 结尾当错别字」 | `*` 是文本习惯不是编辑语义；Telegram 真编辑是独立 `edited_message` 事件。没有可靠信号 |
| A3「建外来 bot 命令签名表」 | 要爬要手填，成本高风险不确定 |
| 改 prompt 让它"温柔点" | 性格重写，副作用不可预测 |

## 四、实施步骤

### 第 0 步｜止血触发面（R1）—— ✅ 已完成（round 167）

**已部署**：`src/meta/ingress-intercepts.ts:121` 加 `opts.isDirect` 要求。
未寻址且本来会试路由的消息，现在走 `incrCounter('command_router_skip_unaddressed_total')`
+ info 日志 `command router: skipped (message did not address the bot)`。

寻址判据**没有新造**——用的就是全仓同一个 `opts.isDirect`
（来自 `detectDirectInteraction`：点名 @bot / 昵称 / 回复 bot / 自身是命令）。

测试 4 条，逐条 `-t` 验过红（把 `if (opts.isDirect)` 改成 `if (true)` → ①④ 红）。

**预期效果**：`command-router: jev matched command` 的分子里未点名样本应归零。

### 第 1 步｜回执判读（R2/R4）

**改**：`src/meta/ingress-intercepts.ts:111` 的条件从

```ts
if (chatId < 0 && !formatted.isBot && text.length >= 3 && ...)
```

改成要求**寻址**——`opts.isDirect || formatted.replyTo?.uid === getBotUid()`，
否则要求消息自带参数形状（给第 2 步的 arity 判据当第二道触发）。

**为什么这个位置**：这是命令路由在**生产主路径（Meta）的唯一入口**。
`getBotUid()` + `formatted.replyTo?.uid` 的比法在 `bookkeeping.ts:262` 已有先例。

**验收**：
- `incrCounter('command_router_skip_unaddressed_total', { chat })` + info 带 preview
- 单测：喂现场那句的确切形状（无 @ 无 replyTo）断言不路由
- 上线后看 `command-router: jev matched command` 的分子里未点名样本归零

**已知代价**：闲聊借命令的命中率下降（这正是目的），但可能砍掉一些本来好用的代发。

### 第 1 步｜回执判读（R2/R4）—— ✅ 已完成（round 168）

**已部署**：`src/pipeline/tools/bot-delegation.ts`
· `isCommandRejection(text)`（`isProgressPlaceholder` 的兄弟函数，120 字上限）
· `tryHandleDelegationReceipt` 在占位**之后**、结果**之前**加一支：命中 → 清 pending
  + `incrCounter('delegation_receipt_usage_error_total')` + info
  `Delegation: receipt is a usage error, not a result`
· `answerFromDelegation(..., rejected=true)` 走另一套指示：「这不是查询结果，
  别把它当数据，更别说"没查到相关数据"…绝对不要自己编一个参数再发一次」

**清 pending 是关键**：不清的话下一条群消息会被当成它的结果消费掉
（现场"答非所问成串"的来源之一）。

测试 7 条（删掉整个分支验过红）。两个新机制接进 verify-deploy CHECKS
（75→77）和 verify-integration 真调 findTopicRepeat（31→34）——
后者是还 round 163 的债：当时加完话题词闸没做集成核验，
导致"说不清它在不在拦"。

**改**：`src/pipeline/tools/bot-delegation.ts` 加 `isCommandRejection(text)`
（`isProgressPlaceholder` 的兄弟函数，放它旁边）。命中时**不当结果消费 pending**，
回给模型"命令被退回：缺参数，问人要或直接说查不了"。

**为什么这个位置**：它是三个调用方的收口；顺带消掉 R4 的双重消费竞态
（同一条回执不再被当成可用结果）。

**验收**：`incrCounter('delegation_receipt_usage_error_total', { chat })`；
单测喂 usage 形状的 bot 消息断言不当结果消费；进 `verify-integration.mts` 真调一次。
弄坏验证：判据恒 false → 测试红。

### 第 2 步｜arity-aware 的缺参闸（R1 的兜底）—— ✅ 已完成（round 169）

**已部署**：`src/pipeline/tools/bot-delegation.ts` 的 `tryDelegateCommand`，
在 `targetBotInChat` 检查之后、发送之前。

- `usageNeedsArg(profile?.usage_syntax)`：只认两种形状（`<占位>`/`[占位]`、
  命令名之后还有裸 token），**认不出来的一律不当成要参数**（漏拦好过误拦）
- 有占位且 `args` 为空时，先 `humanMessageCarriesArg(chatId)` 兜底
  （人类自己带了实参就放行），读不到上下文 fail-open
- 拦住 → `incrCounter('delegation_missing_args_total', {chat,bot,cmd})` + info，
  `return { sent:false, text }`（**不 throw**——`tryDelegateCommand` 契约永不抛）

判据在 14 个**真实** `usage_syntax` 形状上全对（`/geo <IP或域名>`→要，
`/q`/`/re`/`/checkin`/`/stock`/`/cards`→不要，`/q 或回复消息使用`→不要）。
测试 ⑧ 把这个集合钉住，改了判据就红，逼人重新对一遍真实数据。

### 第 3 步｜B 的真主药 —— 已按 k3 裁决改写，(a)(c)(d) 完成（round 170-171）

**k3 2026-09-24 裁决：原 3b 前半否决、后半不动。**理由记在这里，否则下一轮
review 还会把它当方案：

· **`NYATOS_BUDGET_MIN_GAP_ADDRESSED_SEC` 8→20~30 否决**。它是 **chat 级全局**
  阀门（`budget.ts:231` 的 `xxb:nyatos:lastact:{chatId}`，无 task 维度），
  管的是"群里隔多久开一次口"，管不了"一个任务自己连开几次"。
  而且 **30s 是 round 68 按用户"33% 的回复被吐回去"那个抱怨否决不用的值**——
  拿一个已被用户否定的实验值去修一个它管不着的机制，是纯回归。
  验收指标也**不可分辨**：per-task 气泡数下降既可能是"止住连发"，
  也可能是"吐回更多回复"，在 session-report 里长得一模一样。
· **`AGENT_TASK_SEND_BUDGET` 6→3 不动**。单位错配：budget 数的是**调用**，
  而 `>6 条的尾巴 16/1316` 是"3 片一调"的分片副产物，不是预算失灵。
  且调小会走 `endTask('send_budget_exhausted')` → failsafe → **raw sendMessage
  绕过全部闸** → 用户收到"没搞定"的**假失败**，比连发更难解释。
  legitimately 需要 4+ 次调用的形状有四种（中段汇报/回执转述/3 条 interrupt
  各回应一次/跨小时多段任务）。

**(a) 观测（round 170）**：`host sendText` / `continuation` 加 `taskId`。
（之前两条都不带，于是"一个任务发了几个气泡"从日志里算不出来。）
✅ **生产已验证**（2026-09-24 18:33 UTC）：第一条带 `taskId` 的 `host sendText` 出现（chat=-1003821093564　task=ee6ca857　parts=1）。全链路：

```
18:33:18  Meta dispatch.taskToGroup
18:33:19  CodeAct task start
18:33:42  host sendText  parts=1
18:33:43  task delivery recorded
18:33:48  CodeAct task done
18:34:10  episode distilled
```

**一个任务 1 次开口 1 个气泡，29 秒收尾**——健康形状。
而 `session-report.mts` 的“每任务开口次数”维度（round 174 加的）也第一次在生产拿到数据。

仍然 **n=1**——按 round 186 的规矛，一条不算“没病”的证据。
目标样本量：>2 次开口的任务占比（k3 密度判据该治的批次）。

**(c) task 级 burst 闸（round 171，从 3c 提前）**：
`TASK_BURST_GAP_SEC = 12`，读 `xxb:agent:lastsend:{taskId}`（只在一次
sendText **调用完成**后写，不在分片上写），距上次调用 <12s → 抛回模型
`send_task_burst_total` 计数器 + info。**与 MIN_GAP 正交，不可能回归 round 68。**

**两个实现要点**（都是弄坏验证时教出来的）：
1. 判定放 `try` 里、`throw` 放 `try` 外——第一牌把 throw 写在 try 里，
   自己的 `catch` 会把它吐掉，**闸永远不生效**。测试① 钢住这个顺序。
2. `try` 里 fail-open：防变胖的闸不能因为它自己出错挡住发送。

**(d) 修注释脱节（round 170）**：`budget.ts:209` 写死"被叫到 30s"→ 改成引用
env 变量名并指回 `life.ts` 的理由注释。

**行为验证（round 172）**：上面的结构测试（task-burst-gate.test.ts，7 条）只能证明
"代码在那儿"。现在有了 **行为测试**（task-burst-gate-behaviour.test.ts，6 条，
真的调 `host.telegram.sendText` 两次）：

  ① 同一任务紧接着第二次开口 → 抛回模型，且 `sendMessage` 只被调一次
  ② 换一个 taskId → 不受影响
  ③ 没有 taskId（legacy / failsafe）→ 完全不管
  ④ 距上次 > 阈值 → 放行（把键写到 60s 前）
  ⑤ 键真的被写下来（否则第二次永远放行，闸是死的）
  ⑥ redis 读失败 → fail-open（防变胖的闸不能挡住发送）

两种弄坏都验过红：阈值 12→0（① 红）、写键禁用（①⑤ 红）。
现在 **3a/3c 只差生产确认**（群醒了就能看到 taskId 字段和
`send_task_burst_total` 计数器）。

**Step 3（已完成，round 175）：给模型硬约束——k3 明确说这一步不做，
主机闸就永远在后面追（模型换个说法重发）。
`executor.ts` 的工具清单里：

> **一个任务对同一个 chat 只开口一次**：想说的第二句话并进这一条里
> （同一个调用用。分开就会变成多个气泡），别重新调一次 sendText
> ——那正是用户说的「说话太应激」。同理 sendFinal。
> 唯一例外：真的要中途咚一声且隔了很久。

测试 5 条：句子在工具清单那一行里（不是别处注释）·说了正确做法
·点了用户原话（否则被当耳旁风）·给了例外（否则连过渡话都不敢说）·
确认它在模板字符串里而不是 JS 注释。

**仍待数据**：3b 后半（6→3）等 calls 维度观测的数据出来再拍；
**(b) interrupt 分级（观测半边已完成，round 177）**：
k3 排它做最后（动 prompt 语义，风险最高，而且没有数据能验）。
所以先只做**打标 + 分桶计数**，真正的分级等分桶数据出来再定：

· `AgentInterrupt` 加 `addressed?: boolean`（缺省=unknown，不当成寻址）
· `session.ts` 推 interrupt 时打标：点名 @bot / 昵称 / payload 有 replyTo
  → addressed；**判不出来的一律算未寻址**（宁可少拦，不可误拦）
· 两个计数器：`agent_interrupt_addressed_total` / `agent_interrupt_background_total`
  · 旧日志没有这个字段，分桶从本次部署起算

测试 6 条两种弄坏都验过红（addressed 恒 true、不传 addressed）。

按代价排序，**前两步零代码**：

**(a) 先加观测**：interrupt 注入时打
`logger.info({ chatId, taskId, gapSinceLastSendSec, postTaskWindowOpen })`，
量"每次 burst 被注入几条 interrupt"。

**(b) 再调剂量**（.env，零代码）：`NYATOS_BUDGET_MIN_GAP_ADDRESSED_SEC` 8→20~30；
`AGENT_TASK_SEND_BUDGET` 6→3。前后用 `scripts/session-report.mts` 的 per-task 发送分布量。

**(c) 最后才考虑硬闸**：`host-api.ts` trench gate 段加"同任务第 N 次 sendText 且距上次 <X 秒即抛回模型"。
**必须和 round 71 的分片豁免区分开**（分片是同一句话，连发是两次开口），
计数器 `send_task_burst_total`。

**(d) 顺手修 R5 的注释脱节**：把代码注释里写的 30s 改成实际值，否则下一轮 review 还拿 30s 当事实。

### 第 4 步｜补我 round 163 埋的观测债

话题词复用闸（`src/subagent/topic-repeat.ts`）现在：
dist grep 没有（`verify-deploy.mts` 无此项）、`verify-integration.mts` 没调用、
部署后生产 0 次触发——**说不清它是"没必要拦"还是"没在拦"**。
且其历史源 `recentBotTextsByChat` 只被 host sendText 更新，legacy/回执直答/failsafe 的发送不进账。

补：`verify-deploy.mts` 的 CHECKS 加一行；`verify-integration.mts` 真调一次 `findTopicRepeat` 并断言返回值。

## 五、验证总原则（每步都要过）

1. `export PATH=/opt/node22/bin:$PATH && npm run typecheck && npm run lint && npm run test`
2. `npx tsx scripts/verify-deploy.mts`（新机制加 CHECKS）
3. `npx tsx scripts/verify-integration.mts`（新机制要**真的调一次**，不只 grep 字符串）
4. 新闸必须 `logger.info` + `incrCounter`，能回答"拦了多少、拦的是什么"
5. 新测试要"故意弄坏看它红"，且断言查**未注释的代码行**
6. 部署后 `sudo systemctl restart xxb-ts` + health 200

## 六、顺序

**0 → 1 → 2 → 3a → 3b → 3d → 4**（3c 看 3a/3b 的数据再定）

理由：0 止血且让 2 从"每发必拦"降回"真缺参才拦"；1 便宜且纯函数；
3a/3b/3d 零代码，先拿到数据；4 是还债，独立于前四步。

---

## round 200 补记：等数据期间挖出并修掉的四个问题

原计划的 3b 后半 + (b) 都要等数据。等的时候拿同一份日志问别的問題，
结果四个都比原计划那两个 bug 重，都已修完上线：

| # | 发现 | 轮 | 修法 |
|---|---|---|---|
| 1 | **并发限流冷却是 check-then-launch，拦不住并发 herd**。<br>1275 次 concurrent-limit 报错里 **178 次是「同一秒内同一个 label 被打多次」**；87% 的重试间隔落在 300s 冷却期内。<br>→ 这解释了 `All labels exhausted` 为什么降不下来，以及 deep-reflection 35% 产出率 | 197 | ✅ 原子的在飞上限<br>`AI_MAX_INFLIGHT_PER_MODEL`（默认 2）+ INCR/DECR + 120s TTL 兜底 + hedge 侧也占坑 + **三条退出路径都放坑** |
| 2 | **关机卡在 `closeCodeActWorker`**。<br>全日志 384 次关机，53 次 forced exit 里 **48 次卡在第一步**（cron → closeCodeActWorker），而 round 64 修的 closeRedis **一次都没卡过**。<br>→ 卡住 = `process.exit(1)`，systemd 记失败，且跳过 WAL checkpoint / token 记账 / BullMQ 锁释放 | 189 | ✅ 两个 close 各 5s 赛跑 + 各自的 `shutdown step` |
| 3 | **dedup 跳过写在 debug 级，「0 次」是读不到不是没发生**。<br>`gate:evidence` 报「同群同文本去重 0 次（判据场景还没出现）」，按闸自己的判据（同群+前 4 字+30s）回放：**命中 391 次，其中 190 次是真重复** | 191 | ✅ 提到 info<br>（AGENTS.md round 66 那条坑的第三次） |
| 4 | **flag-census 有两份 `SECTION_ORDER`**。<br>round 192 改的是顶部那份，输出构造区那份（不含 `'ai'`）把它盖掉了 → glob 修好了键数（497）但段索引仍停在 12 段/488 | 198 | ✅ 删重复 + `SECTION_DESC` 补 `'ai'` + 测试④钉「段索引覆盖每一段且合计 == total_keys」 |

### 这四件事共同的教学

**它们全是「上一轮/上一环的修复只做了一半」**：

| 修的东西 | 漏的那半 |
|---|---|
| round 83 的冷却 | 只治了新尝试，没治并行已发出的 |
| round 64 的 closeRedis | 修对了，但故障搬到了 closeCodeActWorker |
| round 60 的 dedup | 逻辑在，可观测性在 debug 级 |
| round 192 的 census glob | 改了第一个 SECTION_ORDER，漏了第二个 |
| round 169 的缺参闸 | 拦的条件在，但兜底条件宽到永不为假 |
| round 132 的账本去重 | 行为修好了，账本本身零打点 |

**判断一个修复完没完，要看它治的「机制」有几个面**：行为 / 观测 / 所有调用点。
而这个会话里反复出现的形状是：**第一面修好了，后两面没人看。**

四个扩展成六个——第 5、6 个是 round 201/37-38 补的，它们证明这个形状
**不是四个孤例，是默认结局**。

### 顺带修掉的文档债（round 193/195/196）

OBJECTIVE-STATUS 里三个不可复现的数字，全部换成带分母/带口径的：

- 「33% 曾被闸咽回 → 现在 4%」→ 「1190/48640 入站 = 2.4%（按 Heart decision 作分母 9.7%）」
- 「影子决策 1654 / 今天 259」→ 「当前窗 295；另两个是不同窗口」
- 「重复锚点 24 组→0 组」→ 四个可复现的数 + 「闸①拦 3 次 ≠ 没重复，上游闸拦了 846 次」
- 「同群同文本去重 0 次（场景未出现）」→ 「0 次是读不到，按判据回放命中 391」

**归档**（AGENTS.md）：round 186「没问题的结论要第二个数字」+ round 194「第二个数字必须同口径」。
