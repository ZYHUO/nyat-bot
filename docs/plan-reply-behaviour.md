# 修「不会用别的 bot」+「说话太应激」的实施计划

状态：**进行中**（第 0 步）
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
⚠️ 生产未验证—— 16:32 部署后群还没醒。

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

**仍待数据**：3b 后半（6→3）等 calls 维度观测的数据出来再拍；
(b) interrupt 分级（寻址 vs 噪音）排最后，因为它动 prompt 语义。

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
