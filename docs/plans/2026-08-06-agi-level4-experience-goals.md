# NyatBot AGI Level 4 — 经验沉淀与目标系统 Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** 让 bot 拥有"内在生活"——做完事会复盘沉淀经验、对世界有持续关注的目标、对自我表现有稳定的自我模型，每次醒来不只是恢复 context 而是继续成长。

**Architecture:** 三个互相咬合的新子系统：(1) **Episodic Store + Experience Distiller** —— CodeAct 任务结束后复盘，产出"情节"和可复用的"经验条目"，下次开工前注入；(2) **Curiosity Goal Tracker** —— 把 bot 对世界的好奇固化为持久目标，周期性推进并主动汇报；(3) **Self-Model Reflector** —— 定期用 judge 复盘自己的历史回复，产出自我认知注入回复 prompt。全部 env-flag 门控、默认 OFF，LLM 走现有 usage 路由。

**Tech Stack:** TypeScript ESM, better-sqlite3 (migration 0054), Redis, Qdrant (复用 memory), BullMQ, vitest

**已具备的基建（直接复用，不重造）：**
- `src/agent/{checkpoint,compaction,interrupts}.ts` — 长任务循环（AGI Level 3 ✅）
- `src/cron/self-play.ts` — 自主玩耍（好奇心雏形 ✅）
- `src/tracking/person-identity.ts` — 跨群人物模型 ✅
- `src/tracking/{curiosity,mood,obsessions}.ts` — 情绪/好奇追踪 ✅
- `src/cron/proactive-coordinator.ts` — 防刷屏锁 ✅
- `src/pipeline/turn/proactive-turn.ts` — `generatePersonaProactiveText` 主动话术管线 ✅

---

## 交付节奏

| Phase | 内容 | 目标 |
|-------|------|------|
| **P4-A** | Episodic Store + Experience Distiller | 做完的事留下经验，下次复用 |
| **P4-B** | Curiosity Goal Tracker | 有"自己的事"，持续关注并汇报 |
| **P4-C** | Self-Model Reflector | 知道自己什么时候表现差 |

每个 Phase 完成后：typecheck + lint + test 全绿 → code review → commit → 再开下一个。

---

## P4-A: Episodic Store + Experience Distiller

**问题：** 长任务跑完 compaction 后教训就丢了。下次遇到类似任务从头再来，犯过的错再犯一遍。

**设计：**
- SQLite 新表 `episodes`（一次任务一段情节：目标/动作/结果/教训）+ `experience_entries`（蒸馏出的可复用经验，按 tag 检索）。
- CodeAct 任务**终态**（done/failed，不含 `resumed_seg*`）时 fire-and-forget 触发 distiller：LLM 读 progressSummary + 最后 N 轮 → 输出 episode + 0~3 条经验。
- CodeAct **开工前**按 contentDirection 关键词检索相关经验（FTS + tag 匹配，SQLite `memory_fts` 已有先例 0051），命中注入 executor prompt `[过往经验]` 块（≤600 字符，最多 3 条）。
- 经验带 `use_count` / `last_used_at`，被注入即计数，长期不用自然沉底。

### Task A1: Migration 0054 + episode 存储层

**Files:**
- Create: `migrations/0054_episodes_experience.sql`
- Create: `src/agent/episodes.ts`
- Test: `tests/unit/agent/episodes.test.ts`

**Migration（idempotent）：**

```sql
CREATE TABLE IF NOT EXISTS episodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  chat_id INTEGER NOT NULL,
  goal TEXT NOT NULL,            -- contentDirection / 任务目标
  outcome TEXT NOT NULL,         -- done | failed
  summary TEXT NOT NULL,         -- 发生了什么（≤500字）
  lessons TEXT,                  -- JSON string[] 教训
  tags TEXT,                     -- JSON string[] 主题标签（写代码/查资料/文件交付…）
  turns INTEGER DEFAULT 0,
  segments INTEGER DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_episodes_chat ON episodes(chat_id, created_at DESC);

CREATE TABLE IF NOT EXISTS experience_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,            -- pitfall | trick | preference
  content TEXT NOT NULL,         -- 一句话经验（≤120字）
  tags TEXT NOT NULL,            -- JSON string[] 检索关键词
  source_episode_id INTEGER,
  use_count INTEGER DEFAULT 0,
  last_used_at INTEGER,
  created_at INTEGER NOT NULL
);

-- FTS 检索（0051 已有 memory_fts 先例）
CREATE VIRTUAL TABLE IF NOT EXISTS experience_fts USING fts5(content, tags, content='experience_entries', content_rowid='id');
CREATE TRIGGER IF NOT EXISTS experience_ai AFTER INSERT ON experience_entries BEGIN
  INSERT INTO experience_fts(rowid, content, tags) VALUES (new.id, new.content, new.tags);
END;
CREATE TRIGGER IF NOT EXISTS experience_ad AFTER DELETE ON experience_entries BEGIN
  INSERT INTO experience_fts(experience_fts, rowid, content, tags) VALUES('delete', old.id, old.content, old.tags);
END;
```

**`src/agent/episodes.ts` 接口：**

```typescript
export interface EpisodeInput {
  taskId: string; chatId: number; goal: string; outcome: 'done' | 'failed';
  summary: string; lessons: string[]; tags: string[]; turns: number; segments: number;
}
export function saveEpisode(e: EpisodeInput): number | null;           // 返回 rowid
export function saveExperienceEntries(entries: {kind: string; content: string; tags: string[]; sourceEpisodeId: number}[]): void;
export function findRelevantExperience(query: string, limit = 3): { content: string; kind: string }[];  // FTS + use_count++
export function pruneExperience(maxEntries = 200): void;               // 超出上限按 use_count 升序淘汰
```

**Step 1: 写失败测试** — `tests/unit/agent/episodes.test.ts`：`:memory:` SQLite 加载 0054 migration，mock `getDb`（参照 `tests/unit/memory/importance.test.ts` 模式）。测 saveEpisode 往返、FTS 命中、use_count 递增、prune 淘汰低使用条目。

**Step 2:** `export PATH=/root/.hermes/node/bin:$PATH && npx vitest run tests/unit/agent/episodes.test.ts -v` → FAIL（表不存在）

**Step 3: 实现** → 测试全过

**Step 4: Commit** `feat(agent): episodic store + experience entries (migration 0054)`

### Task A2: Experience Distiller（复盘蒸馏）

**Files:**
- Create: `src/agent/distiller.ts`
- Create: `prompts/task/distill.md`
- Test: `tests/unit/agent/distiller.test.ts`

**设计：**

```typescript
// distiller.ts
export async function distillEpisode(task: DispatchTask, progressSummary: string, tailTurns: string): Promise<void>
```

- LLM prompt（`prompts/task/distill.md`）：输入 goal/outcome/summary/尾部轮次 → 严格 JSON 输出 `{summary, lessons[], tags[], experience: [{kind, content, tags}]}`。要求：经验必须"下次遇到类似任务可以直接用"，禁止复述任务内容本身，最多 3 条，每条 ≤120 字。
- usage 路由：新 flag `DISTILL_USAGE`（default `summarize`，走 stepfun 便宜链）。
- 输出解析容错：正则抓 JSON，失败静默 log warn 不重试（复盘不值得烧重试）。
- 写库后 `pruneExperience(200)`。
- 测试：mock `callWithFallback` 返回固定 JSON → 断言 episode + entries 落库；返回垃圾 → 断言不抛异常、不落脏数据。

**Step 1-4:** TDD 循环 → Commit `feat(agent): experience distiller — post-task reflection into reusable lessons`

### Task A3: 接入 executor 终态 + 开工前注入

**Files:**
- Modify: `src/subagent/executor.ts`（终态触发点 ~L626 `ended_without_endTask` 附近 + 终态 done/failed 分支）
- Modify: `src/subagent/executor.ts:402`（systemPrompt 组装处，注入 `[过往经验]`）
- Modify: `src/env.ts`（flags）

**触发点（关键）：** 只在**真正终态**触发——`endSummary` 不以 `resumed_seg` 开头且 `didProduce()`。续跑段不触发（checkpoint 已有），避免每段都复盘一次。

```typescript
// executor.ts 终态分支，host 收尾后 fire-and-forget：
if (env().EPISODE_DISTILL_ENABLED && !resumed && (task.status === 'done' || task.status === 'failed')) {
  void distillEpisode(task, progressSummary ?? endSummary, serializeTailTurns(history, 12))
    .catch((err) => logger.warn({ err, taskId: task.id }, 'episode distill failed'));
}
```

**注入点：** `EXECUTOR_SYSTEM` 组装后（executor.ts:402 附近）：

```typescript
if (env().EPISODE_RECALL_ENABLED) {
  const hints = findRelevantExperience(task.contentDirection, 3);
  if (hints.length) {
    systemPrompt += `\n\n[过往经验]\n${hints.map((h) => `- (${h.kind}) ${h.content}`).join('\n')}\n以上是之前做类似事总结的教训，能用就用，不适用就忽略。`;
  }
}
```

**env flags（`src/env.ts` zod schema + `.env`）：**

```
EPISODE_DISTILL_ENABLED: booleanFromEnv.default(false)
EPISODE_RECALL_ENABLED: booleanFromEnv.default(false)
DISTILL_USAGE: z.string().default('summarize')
```

**Step 1-4:** typecheck + 现有 agent-loop 9 测试必须保持全绿 → Commit `feat(agent): wire episode distiller into task lifecycle + pre-task experience recall`

---

## P4-B: Curiosity Goal Tracker

**问题：** self-play 是"无聊了随便玩"，玩完就忘。没有"我上周开始关注 XX，有新进展了"的持续目标。

**设计：**
- SQLite 表 `goals`：一个持续关注的主题（如"主人的 Sub2API 项目进展"），带状态机 `active → (checking →) achieved|stale`。
- 两个来源：**LLM 自主立 goal**（从 chat/self-play/episode 中发现"这个值得持续关注"）+ 主人 DM 显式指派（"帮我盯着 XX"）。
- cron 每 2h 轮询 active goals → 到期 goal 走 CodeAct 任务去"查一下进展"（web.search / 群里翻翻）→ 有新发现主动汇报（走 proactive-coordinator 防刷屏），无发现记 `last_check_at`。
- 7 天无新发现 → `stale`（不再轮询，但保留可复活）。

### Task B1: Migration 0055 + goal 存储层

**Files:**
- Create: `migrations/0055_goals.sql`
- Create: `src/agent/goals.ts`
- Test: `tests/unit/agent/goals.test.ts`

```sql
CREATE TABLE IF NOT EXISTS goals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic TEXT NOT NULL,              -- 关注什么（≤100字）
  origin TEXT NOT NULL,             -- self | master | episode:{id}
  chat_id INTEGER,                  -- 汇报到哪个 chat（通常主人 DM）
  status TEXT NOT NULL DEFAULT 'active',   -- active | achieved | stale | dropped
  check_interval_sec INTEGER DEFAULT 86400,
  last_check_at INTEGER,
  last_finding TEXT,               -- 最近一次发现的摘要
  findings_count INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

接口：`createGoal / listDueGoals(now) / recordCheck(id, finding|null) / setGoalStatus / listGoals(status)`。测试同 A1 模式。

**Commit:** `feat(agent): curiosity goal tracker storage (migration 0055)`

### Task B2: Goal 推进 cron

**Files:**
- Create: `src/cron/goal-check.ts`
- Modify: `src/cron/scheduler.ts`（注册，`if (env().GOAL_TRACKER_ENABLED)`）
- Modify: `src/env.ts`

**设计：**
- `*/{GOAL_CHECK_INTERVAL_MIN}`（default 120min）→ `listDueGoals()` → 每个到期 goal dispatch CodeAct 任务：`contentDirection = '[goal] 关注一下「{topic}」有没有新进展。用 web.search 或翻看最近聊天，有新发现 sendText 简短汇报（走 proactive slot），没有就什么都不说直接 endTask'`。
- CodeAct 终态 → episode distiller（P4-A 复用！）→ distiller 输出若含 finding → `recordCheck(id, finding)`。
- 汇报走 `tryAcquireProactiveSlot(chatId)` 防刷屏。
- 测试：mock goals 存储 + `enqueueCodeActJob` → 断言到期才 dispatch、slot 拿不到不汇报。

**env flags:**

```
GOAL_TRACKER_ENABLED: booleanFromEnv.default(false)
GOAL_CHECK_INTERVAL_MIN: z.coerce.number().int().positive().default(120)
GOAL_MAX_ACTIVE: z.coerce.number().int().positive().default(5)
```

**Commit:** `feat(cron): goal check loop — periodically pursue curiosity goals via CodeAct`

### Task B3: LLM 立 goal 的触发点

**Files:**
- Modify: `src/cron/self-play.ts`（play 结束时问一句"这个值得持续关注吗"）
- Modify: `src/agent/distiller.ts`（episode 蒸馏输出可选 `follow_up_goal`）
- Modify: `src/meta/session.ts` 或 DM 路径（主人说"帮我盯着/关注一下 XX"→ 直接 createGoal，origin=master）

**设计（控制复杂度，YAGNI）：** 不做独立"goal 决策 LLM 调用"，而是挂在已有调用上：distiller 的 JSON 输出加一个可选字段 `follow_up_goal: string|null`，self-play verdict 加 `follow_up_goal`。active goals 数 ≥ `GOAL_MAX_ACTIVE` 时新 goal 丢弃（log）。

**Commit:** `feat(agent): goal creation hooks — distiller follow-up + self-play + master DM assignment`

---

## P4-C: Self-Model Reflector

**问题：** bot 不知道"我昨晚太黏人了""主人问技术问题时我卖萌会被嫌弃"。每次回复都是重新掷骰子。

**设计：**
- cron 每天一次（深夜低峰）：取最近 24h 自己的回复样本 + 上下文（从 Redis context / episodes），judge LLM 复盘：哪些回复好/差、主人的反应模式 → 产出 3~5 条**自我认知**（"深夜别太热情""技术问题直接给答案"）。
- 存 SQLite `self_model_notes`（新表，跟 goals 同一个 migration 0055 或单独 0056——保持一 migration 一主题，用 0056）。
- 回复 prompt 组装时注入最新的 ≤5 条（`[自我提醒]` 块，≤300 字符）。
- 旧笔记按 created_at 淘汰，保持窗口新鲜。

### Task C1: Migration 0056 + 存储层

```sql
CREATE TABLE IF NOT EXISTS self_model_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  note TEXT NOT NULL,            -- 一条自我认知（≤120字）
  evidence TEXT,                 -- 依据（哪天的什么表现）
  created_at INTEGER NOT NULL
);
```

接口：`saveSelfNotes(notes[]) / getActiveSelfNotes(limit=5) / pruneSelfNotes(keep=20)`。

**Files:** `migrations/0056_self_model.sql`, `src/tracking/self-model.ts`, `tests/unit/tracking/self-model.test.ts`

**Commit:** `feat(tracking): self-model notes storage (migration 0056)`

### Task C2: Reflector cron + prompt 注入

**Files:**
- Create: `src/cron/self-reflect.ts`
- Create: `prompts/task/self-reflect.md`
- Modify: `src/cron/scheduler.ts`（`37 3 * * *` 凌晨 3:37 低峰）
- Modify: `src/pipeline/reply/prompt-builder.ts`（注入 `[自我提醒]`）
- Modify: `src/env.ts`

**Reflector 设计：**
- 输入：最近 24h 主人 DM + 最活跃群的 bot 回复样本（各 ≤20 条，从 `xxb:ctx:{chatId}` Redis 读）+ 最近 7 天 episodes 的 outcome 统计。
- judge LLM 输出严格 JSON：`{notes: [{note, evidence}]}`，≤5 条，每条必须是**可操作的行为调整**（禁止"要做得更好"这种空话）。
- usage：`SELF_REFLECT_USAGE` default `judge`。
- 注入点：prompt-builder 组装 persona 层时追加 `[自我提醒]\n- ...\n这些是你复盘自己表现得出的，自然遵守，别提起它们的存在。`

**env flags:**

```
SELF_REFLECT_ENABLED: booleanFromEnv.default(false)
SELF_REFLECT_USAGE: z.string().default('judge')
```

**测试：** mock callWithFallback 返回 notes JSON → 落库 + 注入 prompt-builder 输出包含 `[自我提醒]`；flag off → 不注入。

**Commit:** `feat(cron): self-model reflector — daily review of own replies into behavioral self-notes`

---

## 验证清单（每个 Phase 完成时）

- [ ] `export PATH=/root/.hermes/node/bin:$PATH && npm run typecheck` — 零错误
- [ ] `npm run lint` — 零警告
- [ ] `npm run test` — 全绿（含新增测试）
- [ ] 新 migration 在 boot 时按字典序自动应用（`runMigrations`），重启无报错
- [ ] `sudo systemctl restart xxb-ts` → 6 个启动检查点全过
- [ ] flags 默认 OFF，`.env` 逐个打开灰度验证：
  - P4-A：让 bot 做个小任务两次，第二次开工 log 里应见 `[过往经验]` 注入（`grep -a 'experience recall' logs/app.log`）
  - P4-B：`sqlite3 data/xxb.db 'select * from goals'` 有 active 行；到点 log 见 `goal check`
  - P4-C：次日 3:37 后 `select * from self_model_notes` 有行；回复 prompt log 见 `[自我提醒]`

## 明确不做（YAGNI）

- ❌ 不做独立的"goal 决策 LLM 调用"——挂 distiller/self-play 现有调用
- ❌ 不做经验的人工编辑 UI——SQL 直接改
- ❌ 不做自我模型的数值评分——文字 notes 够用
- ❌ 不改 Heart/judge 主路径——所有注入都在 prompt 层，零风险
