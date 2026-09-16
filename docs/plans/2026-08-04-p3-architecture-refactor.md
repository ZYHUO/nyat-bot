# P3: 四段架构重构计划

> **状态**: 草案 — 等用户确认后执行
> **风险**: 高 — pipeline.ts 是 bot 核心，任何 bug 都可能导致 bot 停止回复

## 现状分析

### pipeline.ts (1229 行) 分段

| 段 | 行范围 | 行数 | 内容 |
|---|--------|------|------|
| Format+Media+BotClass | 110-185 | 76 | 格式化、视觉、bot 分类 |
| Bookkeeping | 186-463 | 278 | 上下文保存、记忆、tracking、拦截 |
| Pre-judge intercepts | 465-528 | 64 | 代发回执、降噪、bot 互动 |
| Judge L0+Heart branch | 529-896 | 368 | L0 规则 + 心流路径(238行内联编排) |
| Legacy judge L1/L2 | 897-906 | 10 | 旧链路(基本已废弃) |
| Post-judge | 909-1227 | 319 | 路径策略、mute门、timing gate、reply 发送 |

### 已独立的模块

- `heart/decision.ts` (266行) — 心流判断核心，已被 pipeline.ts 调用
- `heart/self-state.ts` (174行) — 自我状态叙述
- `heart/engagement.ts` (114行) — 参与预算
- `reply/reply.ts` (1030行) — 回复生成（已是独立模块，pipeline 调 `generateReply()`）
- `meta/` — 完全独立，绕过 pipeline
- `vision.ts` — 完全独立

### 真正的问题

pipeline.ts 的 368 行 Judge+Heart 段和 319 行 Post-judge 段包含大量内联编排逻辑：
- L0 规则降级、timing state 读取、冷却 defer、参与预算 — 都内联在 heart 分支里
- 路径策略、mute 门、timing gate 调用 — 都内联在 post-judge 里

## 重构方案

### 原则
1. **只移动代码，不改逻辑** — 纯提取，不重写
2. **每个提取的模块有清晰的输入/输出类型** — 不传 `job` 对象，传明确的参数
3. **pipeline.ts 只做编排** — 按顺序调用各 stage，处理返回值
4. **每步提取后 typecheck + build** — 确保不断

### Step 1: 提取 bookkeeping → `stages/bookkeeping.ts`

**提取内容**: 行 186-463 的所有 bookkeeping 逻辑（上下文保存、记忆写入、tracking、fire-and-forget 拦截）
**签名**: `async function runBookkeeping(ctx: BookkeepingCtx): Promise<void>`
**输入**: formatted, job, e, botUid, isWaitReplay, isDeferReplay
**移除行数**: ~278 行

### Step 2: 提取 heart 编排 → `heart/heart.ts`

**提取内容**: 行 659-896 的 heart 分支编排（L0 降级、timing state、冷却 defer、心流调用、verdict 处理）
**签名**: `async function runHeart(ctx: HeartCtx): Promise<JudgeResult | null>`
**返回 null**: 表示非 heart 路径，继续走 legacy judge
**移除行数**: ~238 行

### Step 3: 提取 post-judge → `stages/post-judge.ts`

**提取内容**: 行 909-1227 的 post-judge 逻辑（路径策略、mute 门、timing gate、defer 处理）
**签名**: `async function runPostJudge(ctx: PostJudgeCtx): Promise<PostJudgeResult>`
**返回**: `{ action: 'reply' | 'skip', ... }`
**移除行数**: ~319 行

### Step 4: pipeline.ts 瘦身

提取后 pipeline.ts 应只剩：
- try/catch 外壳
- format → media → bookkeeping → judge → post-judge → reply 的编排调用
- 锁管理
- 目标: <300 行

## 风险控制

1. **每步提取后 typecheck + build + restart**
2. **不改变任何运行时行为** — 纯代码移动
3. **如果任何步骤导致 test 失败 → 回退**
4. **优先提取最大段**（bookkeeping 278行 + heart 238行 + post-judge 319行 = 835行）

## 不做的事

- 不重写 heart/decision.ts（已经独立）
- 不改 reply.ts（已经是独立模块）
- 不改 meta/ 或 vision.ts（已独立）
- 不改 prompt-builder.ts（单独的解耦任务）
- 不加新功能
