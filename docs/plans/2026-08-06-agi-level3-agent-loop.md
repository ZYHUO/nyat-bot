# AGI Level 3: 长时间 Agent 循环（Long-Running Agent Loop）

日期: 2026-08-06
状态: 计划
前置: AGI Level 2（统一 CodeAct + self-play）已上线

## 问题

现状 `runCodeActTask` 是**一次性同步循环**：

- 单次最多 30 轮 / 120s，跑完即死
- 任务状态不持久：30 轮用完没完成 → 直接收尾，进度全丢
- 上下文不压缩：即使能续跑，history 无限增长 token 必然爆
- 用户无法干预：任务跑起来后用户消息与任务互不可见
- 与 Hermes / OpenClaw 的差距：它们有持久化 agent 循环 —— 任务跨时间存在、
  后台持续执行、可打断、可恢复、长上下文自动压缩

## 设计：分段续跑 + checkpoint + 压缩 + 注入

```
消息 → autoDispatchL0 → CodeAct Segment 0 (≤30轮)
                            │ 未完成
                            ▼
                  checkpoint 保存 history+进度摘要
                            │
                  sendText 汇报进展（"还在弄喵…"）
                            │
                  重新入队 Segment N+1
                            │
                  ┌─────────┴──────────┐
                  ▼                    ▼
         Segment 续跑(恢复history)   用户消息 → interrupt 注入
                  │                    （模型下一段能看到）
                  ▼
            上下文超阈值 → LLM 压缩早期轮次 → 继续
                  │
                  ▼
          完成 → sendText 总结 + sendFile 交付
```

### 核心概念

1. **Segment（段）**：单次 CodeAct 执行的轮次预算（保持 30 轮/120s）。
   段末未 `endTask` → 不丢弃，checkpoint 后重新入队续跑。

2. **Checkpoint**：每段结束把 `{history, 进度摘要, segment, totalTurns, 产出清单}`
   存 Redis（TTL 24h），续跑时恢复。崩溃/重启/换机都能续。

3. **Compaction（压缩）**：history 超过阈值（默认 50 轮）→ judge LLM 把早期
   轮次压成结构化摘要：`目标 / 已完成 / 关键发现 / 下一步 / 教训`。
   压缩后的 prompt = system + 摘要 + 最近 N 轮。Hermes 同款机制。

4. **Interrupt（用户注入）**：任务 active 期间用户发消息 → 写入该任务的
   interrupt 列表（不重复 dispatch 新 CodeAct）。续跑时注入 history 顶部，
   模型自然响应："主人刚问进度" / "主人说先停" / "主人补充了需求"。

5. **硬预算**：`AGENT_MAX_SEGMENTS`（默认 10，即 300 轮）。超限强制收尾：
   发诚实总结（做了啥/卡在哪/产出在哪），标记 `done(truncated)`。

### 文件改动

| 文件 | 改动 |
|---|---|
| `src/meta/types.ts` | DispatchTask 加 `segment?`, `checkpointKey?`, `totalTurns?` |
| `src/agent/checkpoint.ts` | 新增：checkpoint 存取（Redis hash + TTL） |
| `src/agent/compaction.ts` | 新增：history → LLM 摘要压缩 |
| `src/agent/interrupts.ts` | 新增：任务 interrupt 列表存取 |
| `src/subagent/executor.ts` | 段末未完成 → checkpoint+汇报+重入队；开头恢复；interrupt 注入；超限收尾 |
| `src/subagent/queue.ts` | 续跑 job 用独立 jobId（`codeact-{id}-seg{N}`），attempts=1（避免重试风暴） |
| `src/meta/session.ts` | 消息到达时若有 active 长任务 → 写 interrupt，跳过 dispatch |
| `src/env.ts` | `AGENT_LOOP_ENABLED`(off), `AGENT_MAX_SEGMENTS`(10), `AGENT_COMPACT_AFTER_TURNS`(50) |

### 汇报节奏

- 每段结束（未完成）→ 模型已被注入"这是段 N/10，汇报进展后 endTask 由系统续跑"，
  或者系统 failsafe 发一句进展。段内模型自己 sendText 亦可。
- 完成 → 正常 sendText 总结（现有行为）
- 超限 → 诚实收尾

## P0 — 分段续跑骨架

- [ ] env flags + DispatchTask 字段
- [ ] checkpoint.ts（save/load）
- [ ] executor：段末 checkpoint + 重入队 + 恢复 + 段标注入 prompt
- [ ] queue.ts：续跑 jobId 策略
- [ ] 硬预算收尾
- [ ] 测试：checkpoint roundtrip、重入队、恢复、超限
- [ ] 部署验证

## P1 — 压缩 + 用户交互

- [ ] compaction.ts（LLM 摘要，judge usage）
- [ ] executor 压缩接入（段开始前检查阈值）
- [ ] session.ts interrupt 注入
- [ ] executor 注入 interrupts 到 history
- [ ] 测试：压缩、注入、查询/取消
- [ ] 部署验证

## P2 — 沉淀与多任务

- [ ] 任务产出/教训 → 长期记忆（Qdrant）
- [ ] 多任务并发（per-chat 已天然隔离）
- [ ] 进度查询命令（`任务咋样了` 走 interrupt 已有，可加显式命令）
