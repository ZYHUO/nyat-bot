# AGI 能力升级 Plan — 7 大特性（2026-08-06）

用户选择：核心 5 个全做 + 体验升级 6/7/8 做。

## 现有基础（已交付）

| 能力 | 现状 |
|------|------|
| 感知 | 文字消息 + 频道源 + sticker 分析 + allowlist 头像审核 |
| 记忆 | Redis 短期 + Qdrant 长期 + episodes + goals + self-model + scratchpad |
| 决策 | unified-tick（5min 世界状态→LLM 决定一件事）+ Heart（单条心流）+ judge L0/L1/L2 |
| 行动 | 回复/贴纸/转发 + CodeAct 沙盒（写文件/跑代码）+ proactive-turn + dream-journal |
| 进化 | self-reflect 每日反思 + distiller 经验沉淀 + episode recall 注入 |
| 交付 | sendFile（CodeAct 已通）+ sendVoice（TTS 已通） |

## 7 大特性拆解

### P1: 多模态理解（看图参与讨论）

**目标**：群友发图，bot 能看懂并自然参与讨论（"这猫好可爱" / "这代码有个 bug"）

**现状**：`src/pipeline/vision.ts` 只用于 allowlist 头像审核 + sticker 分析；`multimodal.ts` 有 `describeImage` 但可能没接入群聊消息流。

**方案**：
1. 消息格式化时检测图片/贴纸 → 调 vision 描述 → 注入 context（`[图片: 一只橘猫趴在键盘上]`）
2. 描述结果存 Redis 关联 messageId（避免同一张图反复调 vision）
3. Flag：`VISION_CHAT_ENABLED`，默认 ON（感知是基本能力）
4. 用 `AI_PROVIDER_VISION_*` 链（已有）

**改动文件**：
- `src/pipeline/vision.ts` — 新增 `describeChatImage(imageData) → string`
- `src/pipeline/stages/bookkeeping.ts` — 消息保存时检测图片 → 调描述 → 注入 context
- `src/pipeline/context/manager.ts` — context 消息带图片描述字段
- `src/env.ts` — `VISION_CHAT_ENABLED`

**测试**：`tests/unit/pipeline/vision-chat.test.ts`

---

### P2: 工具使用（代码沙盒 + 文件操作 + API 调用）

**目标**：从"聊天 bot"变成"能做事的 agent"

**现状**：CodeAct 沙盒已有（`src/subagent/executor.ts` + `src/sandbox/`），能写文件/跑代码/sendFile/sendVoice。工具注册表 `src/pipeline/tools/registry.ts` 有 SEARCH/FETCH/RECALL 等。

**方案**：CodeAct 沙盒已通，缺的是**普通回复路径也能调工具**（不止 CodeAct 任务）。
1. reply.ts 的 agentic loop 已支持工具调用（`callWithFallback` + tool definitions）
2. 关键：让 judge/heart 决定 REPLY 时，如果需要工具（查天气/搜索/看网页），走 planned 路径 + 工具执行
3. 已有 `reply-with-tools.ts` 框架，需要确认工具注册表在回复链可用

**改动**：可能不需要大改——确认工具链在回复路径可用即可。

**测试**：`tests/unit/pipeline/tools/reply-tools.test.ts`

---

### P3: 自我进化（从对话反馈学习）

**目标**：被夸了→记住什么风格好；被怼了→调整行为；越用越聪明

**现状**：
- `self-reflect.ts` 每日 03:37 反思（主人 DM + 最活跃群样本 → ≤5 条行为调整）
- `distiller.ts` 终态复盘（CodeAct 任务完成后提取经验）
- `self_model_notes` 表存行为调整
- `prompt-builder.ts` 注入 self-model notes

**缺**：**实时反馈**（不是每天一次）+ **反馈信号检测**（被夸/被怼的自动识别）

**方案**：
1. **反馈信号检测**：消息回复后，追踪下一条用户消息的情绪（"哈哈好可爱"=正面，"你说什么呢"=负面）→ 写入 `feedback_events` 表
2. **反馈聚合**：每小时 cron 聚合近期反馈 → 更新 self_model_notes（比每日反思更快）
3. **prompt 注入**：self_model_notes 已在 prompt-builder 注入（P4-C 已做），现在需要确保反馈信号也能影响

**改动文件**：
- `src/tracking/feedback.ts` — 新增：检测用户回复情绪 → 存 feedback_events
- `src/cron/feedback-aggregate.ts` — 新增：聚合反馈 → 更新 self_model_notes
- `src/db/sqlite.ts` — migration 0057（feedback_events 表）
- `src/env.ts` — `FEEDBACK_LEARNING_ENABLED`

**测试**：`tests/unit/tracking/feedback.test.ts`

---

### P4: 跨会话推理链（长期目标追踪）

**目标**："帮我写个网站"→ 分步骤执行 → 每天推进一点 → 多轮完成

**现状**：
- `goals.ts` + `goal-check.ts`（已删，被 unified-tick 取代）
- `agent loop`（分段续跑，300 轮硬预算）
- unified-tick 的 `check_goal` 动作

**缺**：目标拆解 + 进度追踪 + 跨天推进

**方案**：
1. **目标拆解**：用户说"帮我写个网站"→ LLM 拆解为子任务列表 → 存 `goal_subtasks` 表
2. **进度追踪**：每次 unified-tick 检查活跃目标 → 如果有子任务到期 → dispatch CodeAct 执行
3. **跨天推进**：目标不因单次会话结束而消失，每天推进一点

**改动文件**：
- `src/agent/goals.ts` — 新增子任务拆解 + 进度追踪
- `src/cron/unified-tick.ts` — check_goal 时处理子任务
- `src/db/sqlite.ts` — migration 0058（goal_subtasks 表）
- `src/env.ts` — 无需新 flag（goal 系统已有）

**测试**：`tests/unit/agent/goal-subtasks.test.ts`

---

### P5: 语音交互（语音回复）

**目标**：bot 能发语音消息（更自然的交互方式）

**现状**：`src/ai/tts.ts` `synthesizeVoice(text)` → OGG/Opus Buffer（edge-tts）；CodeAct `sendVoice` 已通。

**缺**：普通回复路径也能发语音（不止 CodeAct）

**方案**：
1. 回复生成后，判断是否适合语音（短句/情绪强烈/睡前晚安）→ 调 `synthesizeVoice` → `sendVoice`
2. 或：judge/heart 决定 REPLY 时同时决定 `voice: true/false`
3. Flag：`VOICE_REPLY_ENABLED`，默认 OFF（语音有成本）

**改动文件**：
- `src/pipeline/reply/reply.ts` — 回复后判断是否发语音
- `src/bot/sender/telegram.ts` — 已有 `sendVoice`（CodeAct 用）
- `src/env.ts` — `VOICE_REPLY_ENABLED`

**测试**：`tests/unit/pipeline/reply/voice-reply.test.ts`

---

### P6: 视觉生成（画画/做表情包）

**目标**：能画画/做表情包回应（不止选贴纸）

**现状**：只能选贴纸（`stickers.pick`），不能生成图片。

**方案**：
1. 接入图片生成 API（DALL-E / Midjourney / Stable Diffusion / 或本地 ComfyUI）
2. 新工具：`GENERATE_IMAGE` — 描述 → 生成 → 发送
3. 或：用代码生成（SVG/Canvas）→ 转图片 → 发送

**改动文件**：
- `src/pipeline/tools/image-gen.ts` — 新增：图片生成工具
- `src/pipeline/tools/registry.ts` — 注册 `GENERATE_IMAGE`
- `src/env.ts` — `IMAGE_GEN_ENABLED` + `IMAGE_GEN_PROVIDER`

**测试**：`tests/unit/pipeline/tools/image-gen.test.ts`

---

### P7: 群角色感知（知道自己是"群宠"还是"工具人"）

**目标**：bot 感知自己在群里的角色，调整行为

**现状**：`behavioral-roles.ts` 有群角色追踪（`xxb:active_groups` zset），但可能没用于行为调整。

**方案**：
1. 分析群内互动模式（被@频率、被回复率、被夸/被怼比例）→ 推断角色（群宠/工具人/透明人/被排斥）
2. 角色注入 prompt（"你是群宠，可以撒娇" / "你是工具人，少废话多干活"）
3. 角色变化时通知主人（"我在 XX 群从透明人变成群宠了"）

**改动文件**：
- `src/tracking/group-role.ts` — 新增：角色推断 + 追踪
- `src/pipeline/reply/prompt-builder.ts` — 注入角色信息
- `src/env.ts` — `GROUP_ROLE_ENABLED`

**测试**：`tests/unit/tracking/group-role.test.ts`

---

### P8: 情绪记忆（情绪影响记忆检索权重）

**目标**：心情系统影响长期记忆检索——开心时优先回忆开心的事，难过时优先回忆安慰

**现状**：心情系统有（`MOOD_ENABLED`），记忆检索有（Qdrant），但两者没关联。

**方案**：
1. 记忆写入时打情绪标签（正面/负面/中性）
2. 检索时根据当前心情加权（心情好→正面记忆权重+，心情差→负面记忆权重+）
3. 或：检索后用 LLM 过滤（"我现在心情 X，这些记忆里哪些最相关"）

**改动文件**：
- `src/memory/importance.ts` — 写入时打情绪标签
- `src/memory/chroma.ts` — 检索时情绪加权
- `src/env.ts` — `MOOD_MEMORY_ENABLED`

**测试**：`tests/unit/memory/mood-memory.test.ts`

---

## 执行顺序（按依赖关系）

```
P1 多模态理解（感知层，独立）
P2 工具使用（确认现有链可用，可能零改动）
P5 语音交互（回复链扩展，独立）
P3 自我进化（反馈信号 → self_model_notes，依赖 prompt-builder）
P7 群角色感知（追踪 + prompt 注入，依赖 prompt-builder）
P8 情绪记忆（记忆系统扩展，依赖 Qdrant）
P4 跨会话推理链（目标拆解 + 进度追踪，依赖 goals + unified-tick）
P6 视觉生成（工具链扩展，依赖 P2 确认可用后）
```

## 验证标准

每个特性交付前：
1. `npm run typecheck` 零错
2. `npm run lint` 零警告
3. `npm run test` 全绿
4. 生产验证：`grep -a '<feature-key>' logs/app.log` 确认触发
