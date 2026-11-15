# prompts/ — 25 个 task prompt 的地图

这些 Markdown 是 NyatBot 的行为源码。不是配置、不是模板——**它们就是产品**。
`src/pipeline/heart/heart.ts` 决定"要不要说话"的**条件**，`prompts/task/heart.md`
决定**用什么语气定这个条件**。改代码不改 prompt，行为不会变；反过来也是。

这一份按"我想改什么"索引。每条都给了**加载它的代码**—— prompt 里没有魔法，
你 grep 得到全部。

---

## 按"我想改什么行为"查

| 我想改… | 改这个 | 谁加载它 |
|---|---|---|
| **它话太多/太少** | `task/heart.md` | `src/pipeline/heart/heart.ts` |
| **它回得多慢/多快** | `task/timing-gate.md` | `src/pipeline/timing/precheck.ts` |
| **它说话不像它** | `task/reply.md` | `src/admin/runtime-config.ts`（运行时覆盖） |
| **它人格本身** | `identity/persona.md` + `identity/behavior-style.md` | `heart-adapter.ts` 拼在心流前面 |
| **它怎么判断要不要接（老路径）** | `task/judge.md` | `src/pipeline/judge/micro.ts` |
| **它怎么处理被点名/被回复** | `task/directive.md` | `src/pipeline/directive.ts` |
| **它怎么推断群氛围** | `task/group-norms.md` | `src/agent/group-norms.ts` |
| **它怎么选表达方式** | `task/expression-select.md` | `src/learners/expression-selector.ts` |
| **它怎么学黑话/术语** | `task/jargon-infer.md` + `learn-style.md` | learners 目录 |
| **它怎么规划一次工具调用** | `task/planner.md` + `task/planner-agentic.md` | `src/pipeline/planner/` |
| **它怎么看图** | `task/vision.md` | `src/pipeline/vision.ts` |
| **它做梦/复盘时想什么** | `task/dream*.md` + `self-reflect.md` + `distill.md` | `src/agent/` |
| **它怎么压缩记忆** | `task/mid-term-summary.md` | `src/pipeline/context/mid-term.ts` |
| **它怎么判断路由对不对** | `task/path-reflection.md` | `src/pipeline/path-reflection.ts` |
| **它的技能怎么蒸馏/合并** | `task/skill-*.md` | `src/pipeline/tools/` |
| **它自主行动时想什么** | `task/self-play.md` | 同名 loadCachedPrompt 调用点 |
| **多轮工具循环里怎么说话** | `task/codeact-reply.md` | 同名 loadCachedPrompt 调用点 |

---

## 25 个文件按体积（改之前心里有个数）

| 文件 | 行 | 是什么 |
|---|---|---|
| `task/reply.md` | 148 | 回复写手——最大的一份，也是改它最影响体感的 |
| `task/heart.md` | 117 | 心流判断——**四个出口**（reply/react/wait/pass） |
| `task/judge.md` | 94 | 老 judge 路径（heart 关着时走这条） |
| `task/timing-gate.md` | 62 | 节奏判断（continue/wait/no_action） |
| `task/planner.md` | 61 | 场景分析 + 工具规划 |
| `task/distill.md` | 51 | 任务复盘蒸馏 |
| `task/learn-style.md` | 44 | 学群里的说话风格 |
| `task/self-play.md` | 42 | 自主行动 |
| `task/dream.md` | 42 | 经验整合 |
| `task/dreaming.md` | 33 | 自由时段特权后台 |
| `task/planner-agentic.md` | 33 | Agentic Planner（多轮工具） |
| `task/hobbies.md` | 28 | 爱好蒸馏 |
| `task/post-task-followup.md` | 28 | 任务后极轻量跟进 |
| `task/group-norms.md` | 27 | 群氛围推断 |
| `task/skill-consolidate.md` | 34 | 技能合并 |
| `task/skill-distill.md` | 31 | 技能蒸馏 |
| `task/self-reflect.md` | 29 | 自我复盘 |
| `task/knowledge-summarize.md` | 35 | 群知识库更新 |
| `task/mid-term-summary.md` | 18 | 中期记忆压缩 |
| `task/jargon-infer.md` | 18 | 黑话推断 |
| `task/path-reflection.md` | 22 | 路由复盘 |
| `task/directive.md` | 17 | 点名/回复处理 |
| `task/vision.md` | 19 | 图片描述 |
| `task/expression-select.md` | 13 | 表达方式选择 |

其它目录：`identity/`（人格）、`safety/`（红线）、`style/`（语气）、
`contract/`（输出 schema）、`system/`（系统摘要）、`knowledge/`（世界观）、`meta/`。

---

## 三条改 prompt 的规矩

1. **改完跑 `tests/unit/pipeline/prompt-files.test.ts`。**
   它锁的是"文档承诺的东西真在 prompt 里"——比如心流的 `heard_but_pass` 标记、
   react 的负面清单、`heart-prompt-balance.test.ts` 的三关结构。
   prompt 是行为的主要控制面，而它没有类型检查，**测试是唯一会提醒你改坏了的东西**。

2. **改 behavioral 的 prompt，先说清改前改后 bot 做了什么。**
   "优化了心流 prompt" 不够——说"占比 30% 那条改成 20% 之后，
   某群条/小时从 14.8 降到 X"。这个仓库的 CONTRIBUTING 第 2 条就是这个。

3. **`{bot_name}` 这类占位符是运行时替换的，别删。**
   删了 prompt 会在第一行就出现字面 `{bot_name}`，而 bot 看不出那是 bug。

4. **不知道改哪个 prompt，先读 [`docs/code-tour.md`](../docs/code-tour.md)。**
   它按"一条消息的一生"排了六个文件；想深入某个行为再去它的 task prompt。

5. **工程约定在 [AGENTS.md](../AGENTS.md)，人格基调在 [`identity/persona.md`](identity/persona.md)。**
