# timing gate 核对：哪些该留、哪些该被 NyatOS 取代

> 2026-09-18。核对对象：`src/pipeline/timing/`（1,632 行，7 个文件）。
> 方法：逐项列出 gate 的职责，再逐项核对 NyatOS 当前是否真的覆盖。
> **结论：用户的判断是对的——gate 需要保留，但不是全部保留，也不是原样保留。**

## 一、gate 实际在做什么（逐项）

`runTimingGate` 有 6 项职责，我按代码顺序列，并核对 NyatOS 的覆盖情况：

| # | 职责 | 代码位置 | 生产活跃度 | NyatOS 覆盖 |
|---|---|---|---|---|
| 1 | **冷却**：刚说过话就别再说 | `gate.ts:264-292` | `cooldown silence` 422 次 | ❌ **无**（budget 限"次数/小时"，不限"间隔"） |
| 2 | **talk-value 攒批**：慢群凑够消息再判 | `gate.ts:300-320` | `talk-value below threshold` 151 次 | ❌ **无** |
| 3 | **wait(N) + 到点恢复** | `gate.ts` + `chat-runtime.ts:210` | `wait-resume` 2 次 | ⚠️ **名义上有，实际没有**（见下） |
| 4 | **连续对话免检**：对话中直接放行 | `gate.ts:252-262` | 6 次 | ❌ **无**（NyatOS 每轮都判） |
| 5 | **direct 豁免**：@/回复/私聊不受节奏限制 | `gate.ts:235-237` | 隐含在全部路径 | ✅ **有**（budget 的豁免 + Frame 渲染） |
| 6 | **活跃时段**（asleep） | `metaSleepGate` | 110 次 | ❌ 无（属时段策略，不在 gate 内但同层） |

生产活跃度来自 `logs/app.log` 实测计数。

## 二、最关键的一条：职责 3 我说了但没做到

计划里我写过"`self_scheduled_wake` 让模型自己定下次思考时间，取代 gate 的 wait"。

**核对结果：`self_scheduled_wake` 有写入方，零消费方。**

```
$ grep -rn "listDueSelfWakes|scheduleSelfWake" src/ | grep -v cognitive-clock.ts
(空)
```

即：模型可以"排定"一个唤醒，**但没有任何调度器会去读它、到点唤醒**。
它现在只是一条写进账本、永远不生效的记录。

而老的 wait 链路是**完整的**：
```
handleWaitResume (worker.ts:40)
  → resumeMetaWaitAttention (chat-runtime.ts:245)
  → 到点重新 ingest
```

**这是我在这个仓库反复发现的同一个陷阱（建好了但没接通），这次是我自己犯的。**
所以"NyatOS 覆盖了 wait"这句话目前是**假的**，我不该在计划里那么写。

## 三、结论：gate 该保留什么、删什么

### 必须保留（NyatOS 确实没有，且实测证明需要）

| 保留项 | 理由 |
|---|---|
| **冷却/间隔控制** | Phase 2.3 实测：单决策点 28 分钟想说 48 次、中位间隔 7 秒，且告知无效。budget 只限总数，挡不住"1 分钟内连发 6 条" |
| **talk-value 攒批** | 慢群如果每条都唤醒模型，成本与噪音都不可接受。这是**成本调度**，不是内容判断 |
| **wait + 到点恢复** | 完整的 delayed-job 链路，NyatOS 的替代品尚未接通 |
| **direct 豁免** | 已经双向都有了，两边都必须保留 |
| **活跃时段** | 深夜不打扰是现实约束，与架构无关 |

### 应该被 NyatOS 取代（内容判断部分）

| 删除项 | 替代 |
|---|---|
| `gate.ts` 的 **LLM 调用**（`continue/wait/no_action` 三选一判断） | 单决策点（Frame + Action） |
| `timing-gate.md` 提示词（2,920 字符） | Frame 事实 + 简短动作说明 |
| `gate-history.ts`（喂给 LLM 的历史块） | Frame 的"你自己最近做的" |

**区分标准（与 Phase 1 一致）：**
> gate 的**内容判断**（该不该说）→ 归模型。
> gate 的**物理调度**（间隔、攒批、时段、恢复）→ 归宿主，且要变成模型可见的预算。

## 四、heart / judge / pipeline / reply 的核对

用户说这几个"应该被 NyatOS 和 NyatVM 取代"。逐项核对：

| 模块 | 现状 | 能否被取代 | 缺口 |
|---|---|---|---|
| `judge/rules.ts`（9 条规则表） | 生产活跃 | ✅ **能**（纯内容判断） | 无 |
| `judge/` L1/L2（mini-AI / full-AI） | 生产活跃 | ✅ **能** | 无 |
| `heart/`（心流决策） | **生产主路径** | ⚠️ **部分** | 见下 |
| `pipeline/reply/`（写手 + prompt 5 层） | 生产主路径 | ⚠️ **部分** | 见下 |
| `pipeline/` 编排本身 | 生产主路径 | ⚠️ 需要 NyatOS 先能真实发送 | Phase 3 未做 |

### heart 的缺口

heart 做三件事：
1. **内容判断**（该不该说）→ ✅ NyatOS 能取代
2. **节奏控制**（cooldown / engagement / refractory）→ ❌ 需保留（同 §三）
3. **产出 `judgeResult`**（下游 12 个文件依赖其形状）→ ❌ 需要替换契约，不是删模块

### reply 的缺口

reply 做四件事：
1. **生成文本** → ✅ NyatOS 的 Action.expression 能取代
2. **5 层 prompt 组装**（8,665 tokens）→ ✅ 应被 Frame 取代（Phase 4 计划）
3. **分段/人味层** → ⚠️ 部分（segmenter 规则该删，但"何时发"的物理节奏要留）
4. **发送 + 回执** → ❌ 这是**身体**，不能删，只能换 adapter

## 五、修正后的路线

原 Phase 4"删除决策层"需要拆成两类：

**A. 可以删（内容判断）**
```
judge/rules.ts 规则表
judge/ L1/L2
gate.ts 的 LLM 判断 + timing-gate.md
heart 的内容判断部分
reply 的 5 层 prompt（改 Frame）
path-patterns / path-policy / instruction 正则
```

**B. 必须保留（物理调度），但要改造**
```
冷却 → 从"固定 90 秒"改成 budget 的**间隔维度**（见下）
talk-value 攒批 → 保留，作为唤醒调度
wait-resume → 保留，直到 self_scheduled_wake 有真实消费者
活跃时段 → 保留
发送/回执 → 保留（身体）
```

**B 的改造方向**：给 budget 加**间隔维度**（如"同一群两次主动发言至少间隔 N 秒"），
并把它渲染进 Frame，让模型知道"你现在不能马上再说，因为刚说过"——
而不是被一个它看不见的计时器静默拦掉。

## 六、我必须更正的

1. **计划里"NyatOS 覆盖 wait"是错的**——`self_scheduled_wake` 没有消费者。
   要么补消费者（让它是真的），要么在计划里改成"wait 暂由 gate 保留"。
2. **Phase 2.3 我说"58% 沉默来自计时器 → 闸门太保守"需要再修正一次**：
   计时器确实有代价，但**它不是保守，是在做另一件事**（防自激）。
   我把两件事混成一个"保守"了。
