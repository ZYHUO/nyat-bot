# Sticker Intent Refinement + Skill Plugin System

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development to implement this plan.

---

## Task 1: Sticker Intent 细化

**Goal:** 将 15 个粗粒度 intent 扩展到 35 个细粒度 intent，支持多 intent 输出，提升 sticker 匹配精度。

**Files:**
- Modify: `src/knowledge/sticker/types.ts`
- Modify: `src/knowledge/sticker/store.ts`
- Modify: `src/shared/types.ts` (ReplyOutput.stickerIntent)
- Modify: `prompts/task/reply.md`

### Step 1: 扩展 StickerIntent 类型

将 `StickerIntent` 从 15 个扩展到以下 35 个，保留原有 15 个（向后兼容），新增 20 个：

```
新增: shocked, proud, laughing, pensive, excited, sarcastic, 
      nervous, relieved, determined, mischievous, bored, 
      disappointed, grateful, surprised, embarrassed,
      thinking, celebrating, crying_happy, rage, blank
```

更新 `INTENT_SYNONYMS` 为每个新 intent 添加同义词。

### Step 2: 支持多 intent 输出

修改 `ReplyOutput.stickerIntent` 从 `string | undefined` 改为 `string[] | undefined`（优先级排序，最多 3 个）。

更新 `getReadyStickersByIntent` 接受数组，对每个 intent 打分后取最高分候选。

更新 pipeline.ts 中的 sticker 选择逻辑适配数组。

### Step 3: 更新 reply prompt

在 `prompts/task/reply.md` 中更新 stickerIntent 说明，列出所有 35 个 intent 及其使用场景，允许输出数组（最多 3 个，按优先级）。

---

## Task 2: Skill 插件系统

**Goal:** 让工具系统支持从配置文件动态加载外部 skill，无需修改源码即可添加新工具。

**Files:**
- Create: `src/pipeline/tools/skill-loader.ts`
- Modify: `src/pipeline/tools/registry.ts`
- Create: `data/skills/` 目录 + 示例 skill
- Modify: `src/env.ts` (SKILLS_DIR)

### Step 1: 定义 Skill 配置格式

每个 skill 是 `data/skills/{name}.json`：

```json
{
  "name": "WEATHER",
  "description": "查询指定城市的天气信息",
  "parameters": {
    "city": { "type": "string", "description": "城市名称" }
  },
  "execute": {
    "type": "http",
    "url": "https://api.example.com/weather?city={{city}}",
    "method": "GET",
    "resultPath": "$.current"
  }
}
```

支持 `type: "http"` (HTTP 请求) 和 `type: "script"` (执行本地脚本)。

### Step 2: 实现 skill-loader.ts

```ts
export function loadSkills(skillsDir: string): Record<string, Tool>
```

读取 `skillsDir` 下所有 `.json` 文件，解析为 Vercel AI SDK `tool()` 对象，返回工具 Map。

### Step 3: 集成到 registry.ts

在 `buildToolSet` 末尾调用 `loadSkills`，合并到 tools 对象中。

### Step 4: 创建示例 skill

创建 `data/skills/weather.json` 作为示例（使用免费的 wttr.in API，无需 key）。
