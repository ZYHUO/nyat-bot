# NyatBot AGI Level 5 — 经验自进化闭环 + 生活型主动性 Implementation Plan

> **状态(8/16):✅ 全部 12 Phase 完成 + 独立 reviewer 通过 + 全量开启部署**
> - PR #30 squash merged(main),reviewer 修复 commit 26e2c8b(直推)
> - reviewer 发现并修复:memory-freshness 写侧 no-op、触发器 churn、winner_id 校验
> - 17 个 flags 已全量开启(.env bak-l5-on-1786853652),不灰度
> - Claude 讨论(链接)后续方向:Task 架构/反向阀门/小模型增强 → 见 claude-discussion-notes.md

> **For Hermes:** 分 Phase 实现,每个 Phase 独立测试 + commit + PR(用户偏好按逻辑组拆 PR)。

**Goal:** 把 bot 的经验系统从「记录」升级到「验证-压缩-进化」闭环,并把目标系统升级为「跨周持续关注、能发现世界悄悄变化」的生活型主动性。

**来源:** arXiv 2026-08 真实前沿(用户 2026-08-16 选定):
- ① 经验验证器 → Practice Makes Unsafe(坏经验固化警告)
- ② Dreaming 整合 → MindMemOS(dreaming 合并冗余/冲突)
- A. 长期任务语义 → VibeLifeBench(生活型 agent 主动性评测)
- B. Loop 策略资产化 → OpenLoopEvolve(策略资产化+版本谱系)
- C. 多智能体安全共享 → Mind Viruses(坏思想传染)
- D. 路径质量统计 → QuoteBench(匹配分数掩盖路径失败)
- E. 世界模型 → 面向对象世界模型(轻量落地)

**Architecture:** 全部复用现有基建——SQLite(migrations 0057+)、Redis、unified-tick、distiller/executor、goals 表。全部 env-flag 门控、默认 OFF。

---

## 依赖顺序

```
Phase 1 (①+D): 经验验证器 + 路径质量统计   ← D 是 ① 的数据源,一起做
Phase 2 (②):   Dreaming 整合               ← 依赖 ① 的 verified 字段
Phase 3 (A):    长期任务语义                ← 依赖 goals 系统(P4-B,已完成)
Phase 4 (B):    Loop 策略资产化             ← 依赖 executor(独立)
Phase 5 (C):    多智能体安全共享            ← 依赖 ① 的验证结果
Phase 6 (E):    世界模型(轻量)              ← 独立,最小实现
```

---

## Phase 1: ① 经验验证器 + D 路径质量统计

**问题:** 经验条目进库后没有「这条经验真的有效吗」的验证。一次侥幸成功被蒸馏成经验后永久复用(Practice Makes Unsafe)。且只看任务结果(答案对)会掩盖执行路径的失败(QuoteBench)。

**设计:**

### Task 1a: Migration 0057 — experience_entries 加验证字段

```sql
ALTER TABLE experience_entries ADD COLUMN verified INTEGER NOT NULL DEFAULT 0;  -- 0=未知 1=已证实 2=可疑
ALTER TABLE experience_entries ADD COLUMN success_count INTEGER NOT NULL DEFAULT 0;   -- 注入后任务成功次数
ALTER TABLE experience_entries ADD COLUMN failure_count INTEGER NOT NULL DEFAULT 0;   -- 注入后任务失败次数
ALTER TABLE experience_entries ADD COLUMN last_verified_at INTEGER;
ALTER TABLE experience_entries ADD COLUMN source_kind TEXT;  -- episode | loop_policy | shared

-- episodes 加路径质量
ALTER TABLE episodes ADD COLUMN invalid_tool_calls INTEGER NOT NULL DEFAULT 0;
ALTER TABLE episodes ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE episodes ADD COLUMN path_quality REAL;  -- 0-1,越高越好
```

**注意:** SQLite 的 ALTER TABLE ADD COLUMN 是幂等的吗?不是——需要 `PRAGMA table_info` 检查列存在再 ADD(现有 runMigrations 只跑一次,但为保险用 IF NOT EXISTS 语义:直接 ALTER 即可,因为 migration 只应用一次)。

### Task 1b: 路径质量统计(QuoteBench 理念)

`src/agent/path-quality.ts`:
- executor 终态时统计:总工具调用数、无效调用数(工具不存在/参数错)、重试次数(同一动作重复)、端到端 turns
- 计算 `path_quality = 1 - (invalid_calls + retries) / total_calls`(clamp 0-1)
- 存入 episode 的 invalid_tool_calls/retry_count/path_quality

### Task 1c: 经验验证打分

`src/agent/experience-verify.ts`:
- executor 注入经验时记录 `injected_experience_ids`(Redis 或任务上下文)
- 任务终态(done/failed)后:`injectOutcome(experienceIds, taskStatus, pathQuality)`
  - done + path_quality >= 0.7 → success_count++
  - done + path_quality < 0.7 → 不计数(结果好但路径差,不算证实)
  - failed → failure_count++
  - success_count >= 2 且 failure_count == 0 → verified=1
  - failure_count >= 2 → verified=2(可疑,检索时降权)
- `findRelevantExperience` 检索时:verified=2 的降权排在最后;verified=1 优先

**env flags:**
```
EXPERIENCE_VERIFY_ENABLED: booleanFromEnv.default(false)
EXPERIENCE_VERIFY_MIN_SUCCESS: z.coerce.number().int().default(2)
```

### Task 1d: 测试
- migration 应用后列存在
- path_quality 计算正确(无效调用多→低分)
- injectOutcome:成功2次→verified=1;失败2次→verified=2
- findRelevantExperience:verified=2 排最后

**Commit:** `feat(agent): experience verifier + path quality (migration 0057)`

---

## Phase 2: ② Dreaming 整合(MindMemOS)

**问题:** 经验只增不整合,200 条平铺,重复/冲突并存。

**设计:**
- cron `dream-consolidate.ts`:每周一次(如周日 04:00,复用现有 cron 机制)
- 输入:全部经验条目(kind/content/verified/success/failure_count)
- LLM(judge 链)输出严格 JSON:`{merge: [{keep_id, remove_ids, merged_content}], conflicts: [{id_a, id_b, resolution}], drops: [ids]}`
- 执行:
  - merge:更新 keep_id 的 content(合并后的),删除 remove_ids(经验删除时也删 FTS 行)
  - conflicts:更新冲突条目内容(加入 resolution 说明)
  - drops:删除(use_count 极低 + 未被验证 + 内容过时)
- 每次 dreaming 后跑 `pruneExperience(200)`

**env flags:**
```
DREAM_CONSOLIDATE_ENABLED: booleanFromEnv.default(false)
DREAM_CONSOLIDATE_USAGE: z.string().default('judge')
```

**测试:** mock LLM 返回 merge/conflicts/drops → 断言数据库状态。

**Commit:** `feat(agent): experience dreaming — weekly semantic consolidation`

---

## Phase 3: A. 长期任务语义(VibeLifeBench)

**问题:** goal 只有「查一下」的语义,没有「从今天起持续关注、世界悄悄变了要主动发现」的能力。

**设计:**
- goals 表加字段:`long_term INTEGER DEFAULT 0`(migration 0058)+ `silent_change_detected INTEGER DEFAULT 0`
- goal 的 contentDirection 升级:不只是「查进展」,而是「持续关注 X。世界可能悄悄变了——主动探查,发现没人告诉你的变化」(VibeLifeBench 的 silent changes)
- check_goal 派发时:
  - 若上次 finding 存在 → 对比「这次查到的 vs 上次的」,LLM 判断是否「有变化」
  - 变化 → `silent_change_detected=1` + 主动汇报(proactive slot)
  - 无变化 → 正常记录
- goal 生命周期:long_term goal 即使 findings_count>0 也不 stale(7 天无发现规则对 long_term 放宽到 30 天)

**env flags:**
```
GOAL_LONG_TERM_ENABLED: booleanFromEnv.default(false)
```

**测试:** mock listDueGoals → long_term goal 30 天才 stale;LLM 判断「有变化」→ silent_change_detected=1 + 汇报。

**Commit:** `feat(agent): long-term goal semantics — persistent tracking with silent-change detection`

---

## Phase 4: B. Loop 策略资产化(OpenLoopEvolve)

**问题:** executor 的任务循环策略(观察/规划/验证/恢复/停止)是静态写死在代码里的,不进化。

**设计(轻量版,不做完整版本谱系):**
- `src/agent/loop-policy.ts` + SQLite 表 `loop_policies`(migration 0059):
  ```sql
  CREATE TABLE IF NOT EXISTS loop_policies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,           -- 'verify_before_deliver' | 'retry_on_429' | ...
    description TEXT,
    rule TEXT NOT NULL,           -- 策略内容(注入 prompt 的文本)
    enabled INTEGER DEFAULT 1,
    trigger_count INTEGER DEFAULT 0,   -- 被触发的次数
    success_count INTEGER DEFAULT 0,   -- 触发后任务成功次数
    failure_count INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  ```
- executor 系统 prompt 注入 `[循环策略]` 块:enabled 的 loop_policies 按成功率排序取前 N 条
- 任务失败时:失败模式匹配(如 `429`、`tool not found`、`timeout`)→ 相关策略 failure_count++;自动生成新策略建议(LLM 分析失败 → 产出新规则,人工/自动启用)
- 简单版进化:策略触发后任务成功 → success_count++,失败 → failure_count++;成功率 < 0.3 的策略自动 disable

**env flags:**
```
LOOP_POLICY_ENABLED: booleanFromEnv.default(false)
```

**测试:** 策略注入 prompt;失败→计数;低成功率→自动 disable。

**Commit:** `feat(agent): loop policy assets — evolvable task-loop rules (migration 0059)`

---

## Phase 5: C. 多智能体安全共享(Mind Viruses)

**问题:** bot2 共享大脑,一个 bot 学到的坏经验可能传染给另一个。

**设计(保守,先防后共享):**
- 经验共享 gate:只有 `verified=1` 的经验可以跨 bot 共享
- `experience_entries` 加 `origin_bot TEXT`(migration 0060,默认 'self')
- 检索时:跨 bot 注入只收 verified=1;verified=0/2 仅本 bot 用
- bot2 的 distiller 产出经验标 origin_bot=bot2;共享池(grok2api 池)的 verified=1 经验可被两 bot 用

**env flags:**
```
EXPERIENCE_SHARE_ENABLED: booleanFromEnv.default(false)
```

**测试:** verified=0 经验跨 bot 检索不到;verified=1 可以。

**Commit:** `feat(agent): cross-bot experience sharing — verified-only gate (migration 0060)`

---

## Phase 6: E. 世界模型(轻量,对象中心)

**问题:** bot 对世界的认知是碎片化的(Qdrant 记忆片段),没有「物体/实体为中心的持续状态」。

**设计(最小落地,不做视觉/物理):**
- `src/agent/world-state.ts` + SQLite 表 `world_entities`(migration 0061):
  ```sql
  CREATE TABLE IF NOT EXISTS world_entities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,            -- 实体名(主人/项目/群友/话题)
    kind TEXT NOT NULL,            -- person | project | topic | place
    properties TEXT,               -- JSON {key: value} 持续状态
    last_updated_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  ```
- 更新点:unified-tick 决策 / CodeAct 任务终态时,把「任务里出现的实体」upsert 进 world_entities(名字 + 关键属性)
- 读取点:goal check 任务开工前注入 `[世界状态]` 块(相关实体属性)——让「持续关注」有上下文基础
- 不做:视觉世界模型、物理模拟、多模态——YAGNI

**env flags:**
```
WORLD_STATE_ENABLED: booleanFromEnv.default(false)
```

**测试:** upsert 实体;注入 world state 块。

**Commit:** `feat(agent): lightweight object-centric world state (migration 0062)`

---

# Phase 7-12: Claude 建议批(L1-L6,2026-08-16 用户拍板全做)

来源:用户转发的 Claude 分析(基于 2026 前沿论文)。已实证核对我们现状:
- distill.md 目前只要求「可复用经验 ≤120字」,无原则级/实例级区分(→L1 可落地)
- visibility 层有 private/contextual/public + sourceChatId,无 speaker 维度(→GroupMemBench 记入 backlog,per-chat 隔离已缓解跨群泄漏)

## Phase 7: L1 原则级经验蒸馏(5b — 原则>实例,防能力坍缩)

**问题:** 经验存「上次小明笑了」这类实例级,不可迁移;多轮自进化会能力坍缩而非复利改进(arXiv 2606.04703)。

**设计:** 改 `prompts/task/distill.md`:
- experience content 要求「原则级」:存可迁移策略,不存具体人物/事件
- 示例改:❌「上次这样回复小明他笑了」→ ✅「当有人自嘲时,接梗比安慰更有效」
- 蒸馏 prompt 增加一条硬规则:内容含具体人名/单次事件 → 抽象化后再存
- 复用 Phase 1 的验证器(verified)配套,不做新表

**env flags:** 无(常驻,dreaming/distill 同链)

**测试:** distill 输出 mock 校验 JSON 结构;新增「原则级检查」单元测试(含人名/事件 → 标记重写)。

**Commit:** `feat(agent): principle-level experience distillation (L1)`

## Phase 8: L2 Context rot 防护(1e — 少召回+重排+预算)

**问题:** 5 层 prompt + 4 路检索 = 「迷失在中间」+ 干扰项(语义相似不相关内容主动误导)。填充 >50% 开始偏向近期 token。

**设计:** `src/agent/recall-budget.ts`:
- 检索预算:总注入经验 ≤ 3 条(已实现)+ 记忆 ≤ 4 条(现状)→ 固定上限,不做绝对 token 数(简单优先)
- 重排:已验证(Phase 1)排前,可疑排后(已实现);**新增**:召回后按「与任务目标的语义相似度」二次重排,最高信号放最前
- 注入位置:经验块移到 prompt 中段(避免「迷失在中间」中部效应)
- 不引入新表,复用 Phase 1 排序逻辑

**env flags:**
```
RECALL_BUDGET_ENABLED: booleanFromEnv.default(false)
RECALL_MAX_EXPERIENCE: z.coerce.number().int().default(3)
```

**测试:** 预算截断;重排后已验证优先;注入位置。

**Commit:** `feat(agent): recall budget + rerank (L2)`

## Phase 9: L3 群体风格画像 LoSoNA(1b — 每个群都有自己的空气)

**问题:** 多群运营,玩梗群 vs 正经群,靠写死人格解决不了。模型需要观察群内消息 → 推断该群隐性规范(LoSoNA, arXiv 2606.14600)。

**设计:**
- migration 0062: `group_norms` 表(chat_id 唯一, norms TEXT, sample_count, last_updated_at)
- `src/agent/group-norms.ts`:
  - `inferGroupNorms(chatId, recentMessages)`:LLM 观察最近 N 条消息(取最近 30 条摘要)→ 输出该群隐性规则(≤5 条,如「玩梗多」「不聊政治」「短句风」)
  - 触发:unified-tick 每 6h 对活跃群检查一次(有发言且 norms 过期 >6h 或样本不足)
  - 注入:reply prompt 的 `[群氛围]` 块(该群 norms,非全局)
- 安全:DM 不建 norms;norms 只描述风格,不存具体用户隐私内容

**env flags:**
```
GROUP_NORMS_ENABLED: booleanFromEnv.default(false)
GROUP_NORMS_INFER_USAGE: z.string().default('judge')
```

**测试:** 新建/更新 norms;过期重新推断;注入块;DM 不触发。

**Commit:** `feat(agent): group norm inference (L3, migration 0063)`

## Phase 10: L4 ToM 心智状态层(1c — 白捡的收益)

**问题:** 群聊回复不建模对方心智,像答录机。ToMAgent 表明:回复前生成心智状态即可显著提升策略性长程适应。

**设计:** `src/pipeline/reply/` 注入:
- reply prompt 前加 `[对方此刻的心智]` 引导块:输出 3 行(他想要什么/什么情绪/期待什么反应)再正式回复
- 复用现有 reply 链(judge→reply 两次调用),在 reply 调用内先出心智再出正文(单次调用内完成,不增加 API 往返)
- 心智块只在 Heart 主路径(HEART_ENABLED)开启,群聊场景

**env flags:**
```
TOM_STATE_ENABLED: booleanFromEnv.default(false)
```

**测试:** prompt 含心智块;开启后 reply 调用含引导;DM/群聊分流。

**Commit:** `feat(agent): theory-of-mind state layer (L4)`

## Phase 11: L5 情绪惯性(2c) — ✅ 已存在,不重复建设

**结论:** 现有 `src/tracking/mood.ts`(MOOD_TUNE_ENABLED)已实现 Claude 建议的「一阶动力学」——
`decayValence` 指数衰减(decay_rate 每小时)+ valence bucket + moodPromptHint 注入 reply prompt。
本 Phase 原计划 `mood-state.ts` 被判定为重复建设,**已撤销**(migration/env/代码均未落)。
若后续要增强:在 mood.ts 上加二阶动量(velocity),非本计划范围。

**Commit:** 无(撤销)

## Phase 11: L5 情绪惯性(2c — 二阶动力学 mood state)

**问题:** 无状态基线每轮独立重算情绪 → 忽冷忽热不像活人。一阶/二阶动力学(指数平滑+动量)产生连续性。

**设计:** `src/agent/mood-state.ts` + Redis:
- 每 chat 一个 mood key(0-1 连续值,如 0.5 平静),存 Redis `xxb:mood:{chatId}`
- 更新:每轮回复后 `mood = clamp(mood + α*(valence - mood))`(一阶);可选二阶(velocity)暂缓
- 注入:reply prompt `[心情]` 块:当前 mood 描述(平静/雀跃/低落) + 方向(上升/下降)
- 读取:进入 reply 前 getMood(chatId),回复后 updateMood(chatId, valence)

**env flags:**
```
MOOD_STATE_ENABLED: booleanFromEnv.default(false)
MOOD_ALPHA: z.coerce.number().default(0.3)
```

**测试:** 初始平静;连续正向 → 上升;注入块文本。

**Commit:** `feat(agent): mood inertia via exponential smoothing (L5)`

## Phase 12: L6 记忆陈旧检测(2d — 防引用过时事实)

**问题:** 群友换工作/分手,记忆还在自信引用旧事实;90% agent 易受记忆投毒攻击(mem0 2026 报告)。

**设计(保守,先检测后清理):**
- `src/agent/memory-freshness.ts`:
  - person_identity / user_profiles 加 `last_confirmed_at`(migration 0063)
  - 陈旧判定:属性条目超过 N 天(默认 90)未在新消息中被确认 → 标记 `stale=1`(检索时降权,不删)
  - 反驳检测:新消息含「换/离职/分手/搬/买了」等变化词 + 指向某人 → 将相关旧属性标记 stale 并提示更新
- 注入:检索到 stale 属性时 prompt 注明「(此信息可能过时,以最新聊天为准)」
- 不做:自动删除、投毒防御完整版(记 backlog,先做陈旧检测)

**env flags:**
```
MEMORY_FRESHNESS_ENABLED: booleanFromEnv.default(false)
MEMORY_STALE_AFTER_DAYS: z.coerce.number().int().default(90)
```

**测试:** 超期 → stale;反驳词 → 标记;stale 降权。

**Commit:** `feat(agent): memory staleness detection (L6, migration 0064)`

---

## 验证清单(每个 Phase)

- [x] `export PATH=/root/.hermes/node/bin:$PATH && npm run typecheck` — 零错误
- [x] `npm run lint` — 零警告
- [x] `npm run test` — 全绿(含新增)
- [x] migration 应用无报错
- [x] `systemctl restart xxb-ts` → active
- [x] flags 默认 OFF,`.env` 逐个打开灰度验证

## 明确不做(YAGNI)

- ❌ 不做完整版 Loop 策略版本谱系(OpenLoopEvolve 全文)——只做简单计数进化
- ❌ 不做视觉/物理世界模型——world_entities 只存文本属性
- ❌ 不做跨 bot 双向实时同步——只做 verified 经验的读取共享
- ❌ 不改 Heart/judge 主路径——全部增量注入
- ❌ GroupMemBench speaker 绑定(1a):per-chat 隔离已缓解跨群泄漏,记 backlog
- ❌ RLUF reaction 学习(1d):Telegram reaction 采集成本 + reward hacking 风险 + EMNLP 冷水(长问题无效),记 backlog
- ❌ Inner Thoughts / 空闲计算(2a/2b):Heart gate 已有 act 判定 + unified-tick 已有 self-play
