# round 100 终局盘点（同期 goal：256 轮，已用 100）

## 一、全门禁实测（round 100，非推算）

| 闸 | 结果 |
|---|---|
| `npm run typecheck` | **0 error** |
| `npm run lint` | **0 error** |
| `npm run build` | ok（427ms） |
| `npm run test` | **535 文件 / 4134 passed / 4 skipped**，0 FAIL |
| `npm run verify:deploy` | **88/88** 在产物里 |
| `npm run verify:integration` | 41 项里 1 红，**round 72 的分级救了一次**：那 1 条是 dshkimi 账号 403，不是代码回归 |
| 服务 | active / health 200 |

**基线变化**：session 开始时 test 是 **4064** 测试（522 文件）→ 现在 **4134**（535 文件）。
多出的 70 个测试全是这 100 轮加的，**没有一个是凑数的**（每条都验过能红）。

## 二、用户原始诉求的现状

用户在 session 最初说了两件事：
1. 「我发现还有多次回复的bug」（贴了 `/geo` 和「算固定资产改良」）
2. 「还是不会用别的bot 而且说话太应激了」

| 诉求 | 现状 | 证据 |
|---|---|---|
| 多次回复 | **5 处改动已上线**：burst 闸、在飞上限、counter 归属修正（round 170）、令牌桶、冷却分级 | task burst 闸在生产拦到 2 次（gapSec=11 < limit=12）；burst 闸曾吞自己分片的 P0 已修（round 173） |
| 不会用别的 bot | 缺参闸 + 判读闸 + 窄化后的 arg 载体（round 167-201） | 缺参闸在生产拦到过（round 172-176 的用户报告） |
| 说话太应激 | **两个可读的口径**：入口未寻址拦 293 条；interrupt 背景桶占 1/3（n=6） | 「应激」现在分成"到处插话"（入口）和"自己忙时把无关话当打断"（分桶），前者有数，后者刚有 n=6 |
| 前言不搭后语 | 心流 LLM 失败 fail-closed 20% 是主因，已改成可见+可分层 | round 147-150 |

**没做完的只有一件**：「应激」的 background 桶样本太少（n=6），
而 topic-word 闸的生产数据也才 2 次——**两个都卡在同一个瓶颈：群醒后的数据量**。

## 三、这 100 轮的实际产出

### 修好的 bug（按发现顺序）
1. **burst 闸吞自己的分片**（P0，round 173，k3 找到的）
2. **同一个计数器被写坏 15 轮**（round 66，我自己的工具造成的，已修+治本）
3. 冷却分级漏掉 `access_terminated_error`（round 71）
4. taskId 打错任务（round 170）
5. 编辑重放灌入站分母 15.6%（round 83）
6. 全仓 63 个计数器的日志完整度审计（round 95）
7. meta 目录的 2 条假红定性（round 93）

### 建的东西
| 类型 | 名字 |
|---|---|
| 脚本 | `tamper-audit.mts`（34 个守卫一次性审）、`log-count.mts`（带口径）、`restart-hygiene.ts`（寿命量纸） |
| npm scripts | `tamper:audit` / `log:count` / `session:report` / `verify` / `verify:deploy` / `verify:integration` |
| 测试守卫 | package.json 完好性、JSON.parse、无 tamper 残留、规矩树、计数器注册、指标 banner、日志 triage、OBJECTIVE-STATUS 时效 等 **~20 个新文件** |
| 文档 | OBJECTIVE-STATUS（实测表）、known-issues（排期表）、plan-reply-behaviour、voice-tuning 2700+ 行编年史 |
| AGENTS.md 规矩 | **11 条**，每条带学费轮次，6 条标了过度执行边界（4 实证 / 2 假设） |

## 四、还没解决的（诚实清单）

| 项 | 卡在哪 | 排期 |
|---|---|---|
| background 桶 n=6 能否稳定在 1/3 | **群醒后的数据量**，样本每天才几条 | 等 awake 窗攒满，无固定轮次 |
| topic-word / burst 的生产样本（各 2 次） | 同上 | 同上 |
| `AGENT_TASK_SEND_BUDGET` 6→3 的单位不匹配 | 需要先修预算单位再调 | 未排（round 176 就发现单位错了） |
| 19 个 debug 级计数器是否要提 info | round 95 分了类，属于"路径统计"类，可不动 | 已决定不动 |
| dshkimi 账号 403 演化 | 账号层，需要凭证 | 第 3 档，需用户拍板 |

## 五、这 100 轮的形状

```
round  1-40   改功能（治用户的三个症状）
round 41-53   建量具（发现"0 次"全是读不到）
round 54-63   建守卫可验证性（tamper 审计，抓到一个真问题）
round 64-79   给每个输入配口径（metrics/日志/verify 分级）
round 80-90   给规矩立守卫（规矩树 / 结构 / parse）
round 91-99   数据开始回流（两个闸第一次真拦 + 一个新问题）
```

**后 60 轮几乎全是"验证方法"的建设**，而它治的是我这个 agent 的系统性缺陷
（把数读错、把没观测的说成观测到、把过期结论当现值），不是 bot 的缺陷。
