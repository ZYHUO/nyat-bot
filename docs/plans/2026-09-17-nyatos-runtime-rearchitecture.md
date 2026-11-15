# NyatOS Cognitive Runtime 重构计划

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** 将 NyatBot 从“多个入口各自决定并发送回复”的 agent/chatLLM 组合，迁移为一个由事件、认知帧和行动生命周期驱动的持续运行时；先完成可回放的统一主循环，再逐步开放主动观察、长期任务和多媒体社交行动。

**Architecture:** Telegram、Heart、Meta、scheduler 和工具都只产生有范围的 host event。`CognitiveTurnRuntime` 将 event 物化为 frame，接受多个候选行动，交给无副作用的 Action Board 仲裁，并通过 adapter 执行和提交 receipt。旧 judge、Heart、Reply、CodeAct 在迁移期间只是 candidate/adapter，不再各自维护“完成”的第二套语义。

**Tech Stack:** TypeScript/Node 22, better-sqlite3 WAL, append-only `cognitive_events`, outbox, BullMQ/Redis, grammY, Vitest.

---

## 现状核对（2026-09-17）

### 已经存在但尚未统一的能力

- [`src/agent/cognitive-events.ts`](../../src/agent/cognitive-events.ts) 已有 append、dedupe、scope、sequence 和 outbox，但调用方仍直接拼装各自的 action/result 记录。
- [`src/agent/cognitive-kernel.ts`](../../src/agent/cognitive-kernel.ts) 已有 trigger/frame/envelope/outcome 原语；它目前是被 `pipeline.ts`、`meta-api.ts` 和 delivery 分别调用的 shadow API，不是唯一的 turn owner。
- [`src/agent/action-board.ts`](../../src/agent/action-board.ts) 只做纯排序/冲突观察，未负责 candidate 的 accepted/rejected transition。
- [`src/agent/cognitive-workspace.ts`](../../src/agent/cognitive-workspace.ts) 能读取 scoped projection，但不同入口仍自行决定何时读取、何时更新。
- `pipeline.ts` 的 legacy judge、Heart、Meta dispatch、CodeAct、Reply sender 和 cron 仍拥有不同的生命周期；同一 Telegram 消息可能出现多个 correlation，跨重启恢复依赖各模块自己的状态。

### 真实断点

1. **行为主权分裂**：Heart 决定是否开口、Meta 决定是否排队、Reply 决定是否发送、timing 决定是否等待；这些判断无法在一个 frame 中比较。
2. **candidate 与事实混淆**：模型候选、legacy judge 结果、Telegram 真实回执混在不同 ledger；“模型说完成”仍可能被误当完成。
3. **恢复粒度错误**：现有 wake/checkpoint 可以恢复进程，但不能恢复一个正在 arbitration 或 adapter retry 中的 turn。
4. **主动性没有身体接口**：sensor/value/affect/mission 已可记录候选，却没有统一的 wake -> observe -> propose -> settle 运行时。
5. **实时互动仍是 reply-first**：分段、媒体目的、等待和 follow-up 没有作为一个行动计划竞争，无法用结果反馈改变下一次选择。

## 目标运行时

```text
host event
  -> TurnRuntime.open (trigger + scoped frame + cursor)
  -> lenses propose candidates
  -> ActionBoard arbitrate (accepted/rejected/deferred)
  -> adapter dispatch (Telegram / read-only sensor / CodeAct)
  -> receipt + outcome
  -> prediction error / cursor checkpoint / next wake
```

### 核心对象

```ts
type CognitiveTurn = {
  id: string;
  scope: CognitiveScope;
  triggerEventId: string;
  frameEventId: string;
  correlationId: string;
  candidates: ActionEnvelope[];
  selectedEnvelopeId?: string;
  phase: 'opened' | 'proposed' | 'arbitrated' | 'executing' | 'settled' | 'aborted';
};
```

- `trigger`、`frame`、`candidate`、`transition`、`outcome` 都是 append-only event。
- `CognitiveTurnRuntime` 不调用模型、Telegram 或工具；依赖以 adapter/port 注入，故 replay 不会产生副作用。
- `ActionBoard` 只能选择和解释候选，不能提升 capability、scope 或预算。
- `settle` 只接受 host receipt；失败、取消、超时和未知都保留为 outcome。
- `cursor` 保存最后处理的 sequence，重启后可从上次 frame 继续，不依赖进程内 Map。

## 分阶段路线

### Phase A：Turn Runtime 收口（本轮）

**目标：** 保持 legacy 字节行为不变，把所有 Kernel 触点变为统一 runtime API。

- 新增 `src/agent/cognitive-turn-runtime.ts`，实现 `open/propose/arbitrate/transition/settle/abort`。
- runtime 接受 `KernelPort`，生产默认绑定现有 Kernel 函数，测试可使用内存 fake。
- `pipeline.ts` 只负责把 Telegram update 和 legacy judge 转成 runtime 输入。
- `post-judge.ts`、`deliver.ts` 只调用 runtime settle，不直接查找 envelope 或写 outcome。
- `meta-api.ts` 的 dispatch proposal 复用 runtime；CodeAct queue receipt 作为 adapter receipt。
- 为每个候选写 accepted/rejected/deferred transition；拒绝不删除候选，便于 replay 比较。

**验收：** 同一消息只有一个 runtime correlation；重试不产生第二个 envelope/outcome；`shadow` 关闭时发送字节和 latency 路径不变；跨 scope、孤儿 outcome、重复 settle 均有测试。

### Phase B：Durable cursor 与恢复（部分完成）

- [x] 新增 `cognitive_cursors` 表：`scope_key`, `stream`, `occurred_at`, `event_id`, `lease_owner`, `lease_until`, `updated_at`（`0111_cognitive_cursors.sql`）。
- [x] 新增 `src/agent/cognitive-cursor.ts`：claim、advance、release、replay-from-cursor；SQLite 条件更新保证抢占安全。
- [x] crash 后不重发：`src/agent/cognitive-recovery.ts` 按 scope 把超预算的 `dispatched` envelope 结算为 `interrupted`（`resent: false`），游标不跳过仍在预算内的 open action。
- [ ] turn runtime 在 `open` 时读取 cursor：目前 `open` 走的是 kernel frame rehydration（`rehydrated: true`），cursor 只由 recovery 消费。
- [ ] outbox projector 和 process runtime 仍使用各自的 lease/checkpoint，未统一到同一 cursor 协议。

**验收：** kill/restart replay 不重复发送（recovery 不重发，已测）；过期 lease 可被新 worker 接管（cursor 单测）；旧 event 不会污染新 scope（recovery 跨 scope 隔离已测）。

### Phase C：多 lens 认知帧

- 新增 `src/agent/cognitive-lenses.ts`：`social`, `task`, `care`, `curiosity`, `repair`, `skeptic` lens。
- lens 只读一个 `CognitiveFrame`，返回 bounded candidate；禁止互相传递 prompt 或隐藏推理。
- Heart 成为 `social` lens，Meta 成为 `task` lens，主动 tick 成为 `curiosity/care` lens；旧入口不再直接 short-circuit sender。
- Action Board 引入目标、冲突、节奏、未完成项、媒体目的和 capability 缺口的统一评分接口；评分结果写 metadata。

**验收：** 一个 trigger 可回放多个 lens 的候选和选择；同一 scope 的 speak/wait/work 冲突可解释；没有候选时是合法 frame 结果，不是异常。

### Phase D：Action compiler 与 Telegram 身体

- 新增 `src/agent/action-compiler.ts`，把一个 envelope 编译成 text bubbles、reply target、media、reaction、wait、follow-up 的执行计划。
- `social-act-compiler.ts` 迁入通用 compiler，保留图片 purpose、分段和能力未知的 deferred 语义。
- grammY sender 作为唯一 Telegram adapter；真实 `messageId`、403、rate limit、edit/delete 结果都转为 receipt。
- adapter 按 envelope id 做幂等；重启和 retry 不能重新产生外部副作用。

**验收：** 多段消息和媒体的每个 bubble 都可追溯；Telegram 限制编译失败有 outcome；未知能力不被当作可用。

### Phase E：持续认知进程与主动感知

- process registry 统一 `observer/social_mind/world_modeler/strategist/skeptic/inventor/memory_curator/self`。
- 每个 process 只有 `wake -> read frame -> propose -> checkpoint`，使用 cursor、lease、deadline 和 stop。
- `SensorProposal` 由 read-only host adapter 结算；`ValueProposal` 需要实验、反证和 held-out evidence 才能 adopted。
- `AffectEpisode` 只影响 attention、节奏、表达和 repair 候选，不覆盖外部事实。

**验收：** mission/process 跨重启恢复；用户 stop 后无新副作用；provider failure 只产生 retryable observation。

### Phase F：学习与行动电路

- prediction error 更新 attention、mission priority、节奏和候选排序，而不是直接改 prompt。
- 成功轨迹生成 `ActionCircuit` candidate；host receipts、historical replay、counterfactual replay、held-out replay 分开计数。
- 只有 verified circuit 才能进入下一轮候选；失败 mutation 和反证永久保留。

**验收：** 失败后下一次候选顺序有可观测变化；跨群 holdout 有收益；promotion 可定位 evidence event；不以 token 数或裸文本相似度宣称进步。

### Phase G：Authority canary

- `shadow -> advisory -> canary -> authority` 按 action kind 逐个切换：文本、wait、media、CodeAct、admin。
- 每次切换需要冻结 baseline、指定 chat allowlist、人工 stop、rollback threshold 和至少一个完整观察窗口。
- admin 权限只作为 host capability observation；模型不能授予自己管理员权限、扩大 scope、隐藏操作或制造依赖。

**验收：** authority 失败不回退 legacy 重发；scope violation、伪造 receipt、重复发送、stop 失效自动降级并保留事件。

## 本轮执行任务清单

1. [x] 写出本重构计划并记录现状 map。
2. [x] 实现 `CognitiveTurnRuntime` 及 fake-port 单测。
3. [x] 将 Telegram pipeline 的 trigger/frame/action 接线迁移到 runtime。
4. [x] 将 post-judge/delivery 的 outcome 接线迁移到 runtime。
5. [x] 将 Meta dispatch observation 接线迁移到 runtime。
6. [x] 运行 Node 22 `typecheck`, `lint`, runtime 专项测试和全量 Vitest。
7. [x] 构建并重启服务；默认保持 `COGNITIVE_KERNEL_ENABLED=false`，只核验启动与旧路径。

## 接续轮补齐（2026-09-17，Codex 交接后）

上一轮把 Phase A/B 的代码写完但停在第 6/7 项，且有三处“计划已承诺、代码未接线”。本轮补齐：

1. **Kernel shadow 灰度**：新增 `COGNITIVE_KERNEL_CHAT_IDS` 与 `isKernelShadowChat()`。`pipeline.ts` 和 `meta-api.ts` 原先只判 `COGNITIVE_KERNEL_ENABLED` 就全量写账本，无法按计划“只为内部群打开 shadow”。空列表仍等同全量，行为可回滚。
2. **`deferred` 成为持久生命周期**：`arbitrate()` 原先把 capability unknown 的候选留在内存 board 里（`deferred` 只存在于返回值）。现在会写 `action_envelope_transition(status='deferred')`，重启/重放仍能看到“因为缺 host capability 而没执行”，且不会被误判成 `cancelled`。
3. **恢复从文档承诺变成运行时契约**：新增 `src/agent/cognitive-recovery.ts`。
   - 背景：`cognitive-cursor.ts` 落地后**没有任何 src 调用方**，restart 后停在 `dispatched` 的 envelope 永远没有终态。
   - 行为：按 scope 扫描 kernel 生命周期，只把**超出 host budget（`maxWallClockSec`）仍无 receipt** 的 dispatched action 结算为 `interrupted`，receipt 记录 `resent: false`。绝不重发——崩溃后 Telegram 回执未知时重发正是重复副作用。
   - 游标：走 `cognitive-cursor` 的 lease，且遇到“仍在预算内”的 open action 时**不推进游标**，避免后续 sweep 跳过它。
   - 开关：`COGNITIVE_KERNEL_RECOVERY_ENABLED`（默认 OFF）+ scheduler `cognitive-kernel-recovery`（60s）。

验证（本轮，Node 22 `/opt/node22/bin`）：

- `npm run typecheck`、`npm run lint` 干净。
- 新增 `tests/unit/agent/cognitive-recovery.test.ts`（5 例：超预算结算、预算内保持 open 且游标不动、已有终态不重开、重复 sweep 幂等、跨 scope 隔离）。
- 扩充 `tests/unit/agent/cognitive-kernel.test.ts`：灰度门控、restart 后 `rehydrated` 恢复 open turn。
- `tests/unit/agent/cognitive-turn-runtime.test.ts` 更新为断言 deferred transition 落库。
- 全量 Vitest：见下方“运行证据”。

## 执行记录（2026-09-17）

- `src/agent/cognitive-turn-runtime.ts` 已成为生产 Kernel port 的统一生命周期入口：`open` 创建 trigger/frame，`propose` 收集候选，`arbitrate` 写 selected/cancelled/deferred transition，`settle` 只接受 host outcome。
- Telegram `pipeline.ts`、`post-judge.ts`、`deliver.ts` 已不再直接调用 `cognitive-kernel.ts` 的原语；它们只持有 runtime turn，默认 flag 关闭时无额外行为。
- `meta-api.ts` 的 dispatch observation、CodeAct queue acceptance 和失败 settlement 已复用同一 runtime session；旧队列仍是实际执行器。
- `0111_cognitive_cursors.sql` 与 `cognitive-cursor.ts` 已加入可恢复的 scope/stream lease 和全局 occurred-at/event-id 增量 replay；`cognitive-recovery.ts` 是本轮的第一个真实消费方。
- Node 22 下 runtime/cursor/kernel/recovery 专项测试通过。

## 仍未完成（需要人工输入，不是实现遗漏）

- **真实 authority canary 未运行**。`SOCIAL_ACT_SHADOW_ENABLED`、`COGNITIVE_CONTINUITY_ENABLED`、`COGNITIVE_PROCESS_RUNTIME_ENABLED`、`COGNITIVE_KERNEL_RECOVERY_ENABLED` 在生产 `.env` 中仍然缺失（=默认关闭）。
- 主路径仍由 legacy Heart/Meta/Reply 拥有发送权；SocialAct 尚未成为行为权威。
- 没有真实跨天/跨重启 mission 证据，没有 held-out Action Circuit 发布，没有 sensor/value 实验结论。
- 以上都需要主人指定：内部测试群 chatId、主人 DM、冻结 baseline、观察窗口。没有这些事实时保持默认关闭是配置状态，不是实现缺失。

## 证据与回滚

- 测试：`tests/unit/agent/cognitive-turn-runtime.test.ts`、`tests/unit/agent/cognitive-recovery.test.ts`、现有 Kernel/ActionBoard/SocialAct 测试、完整 Vitest。
- 运行证据：runtime correlation 数、candidate/transition/outcome 数、重复 receipt 数、scope violation 数、发送 latency。
- 回滚：关闭 `COGNITIVE_KERNEL_ENABLED` / `COGNITIVE_KERNEL_RECOVERY_ENABLED` 或恢复上一构建；事件表不删除、不重写，旧 sender 继续工作。
- 不做的事：不开放任意主机命令、不让模型自授权 admin、不把“更像真人”当作安全或能力证明，不用 prompt 堆叠替代运行时重构。
