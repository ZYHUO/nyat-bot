# NyatBot 功能增强与优化计划

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** 六项新功能/优化 + 一项删除，提升 bot 稳定性、活人感与信息感知能力。

**Tech Stack:** TypeScript ESM, grammY, BullMQ+Redis, better-sqlite3, Node v22 (`/root/.hermes/node/bin/node`)

---

## 优先级分组

| Phase | 内容 | 复杂度 |
|-------|------|--------|
| P0 | 删除群@早安晚安 + 沉默告警 | 低 |
| P1 | Provider 熔断 + 语音消息 | 中 |
| P2 | 主动搭话升级 + RSS 信息监控 | 中高 |
| P3 | 四段架构重构 | 高 |

交付节奏：P0 → code review → P1 → code review → P2 → review → P3

---

## P0-A: 删除群@早安晚安行为

**问题：** bot 好感达到阈值后，如果跟某用户没有 DM 私聊，会在群里 @那个人 发早晚安。用户认为这很蠢。

**现状分析：**
- 群问候路径：`src/cron/sleep-cycle.ts:324-327`（晚安）/ `:347-348`（早安）
- 门控：`SLEEP_ANNOUNCE_ENABLED`，`pickActiveChats(windowSec)` 按群活跃度选群
- `announce()` → `sendMessage(chatId, text)` — 这是 bot 在群里自言自语式问候，不 @ 具体人
- DM 悄悄话路径：`src/pipeline/dm-proactive.ts:90-108`，好感 ≥40 的用户私聊发早晚安
- **群@行为实际上不在 sleep-cycle 里** — 群问候是 bot 自己说"晚安了大家"，不带 @

**需要确认的：** 调研显示群问候路径不带 @specific user。用户说的"群@那个人"可能是：
1. DM 问候失败（用户 block 了 DM）后 fallback 到群里 @ — 需要检查 `dm-proactive.ts` 的 block-safe 逻辑
2. 或者是另一处代码 — 需要搜索 `@` 或 `mention` in sleep/greeting 相关文件

### Task 1: 精确定位群@早安晚安代码

**Files:**
- Search: `src/cron/sleep-cycle.ts`, `src/pipeline/dm-proactive.ts`, `src/pipeline/turn/proactive-turn.ts`
- Search for: `mention`, `@`, `reply_to`, `targetUser`, `affinity` in greeting context

**Steps:**
1. `grep -rn 'mention\|@\|reply_to_message_id\|targetUid\|targetUser' src/cron/sleep-cycle.ts src/pipeline/dm-proactive.ts`
2. 检查 `dm-proactive.ts` 中 DM 失败后是否有群 fallback 逻辑
3. 检查 `sleep-cycle.ts` 的 `announce()` 是否带 mention
4. 确认后记录精确行号

### Task 2: 移除群@行为

根据 Task 1 发现，移除或修改"没有 DM 就在群里 @ 那个人"的逻辑。

**可能方案：**
- 如果是 DM 失败后 fallback 到群 @：删掉 fallback，DM 失败就静默跳过
- 如果是 `announce()` 带 @：改为不带 @ 的纯群问候（或直接关掉群问候）

**Files:**
- Modify: `src/cron/sleep-cycle.ts` 或 `src/pipeline/dm-proactive.ts`（取决于 Task 1）

**Test:**
```bash
export PATH=/root/.hermes/node/bin:$PATH
npx vitest run tests/unit/cron/ -t "sleep" -v  # 如果有相关测试
npm run typecheck
```

### Task 3: 重启验证

```bash
sudo systemctl restart xxb-ts
# 检查日志无报错
tail -c 3000 /root/xxb-ts/logs/app.log | strings | grep -E 'error|Error|WARN'
```

---

## P0-B: 沉默告警

**问题：** bot 卡住（provider 级联失败、pipeline bug、Redis 断连）时完全沉默，主人无感知。

**目标：** bot 连续 N 分钟没回复任何消息 → DM 主人告警。

### Task 4: 创建沉默告警 cron

**Files:**
- Create: `src/cron/silence-alert.ts`
- Modify: `src/cron/scheduler.ts`（注册新 cron）
- Modify: `src/env.ts`（加 flag）

**设计：**
```typescript
// src/cron/silence-alert.ts
// 每 5 分钟检查：
// 1. 从 Redis 取 `xxb:metrics:last_bot_reply`（bot 最后一次成功回复的 timestamp）
// 2. 如果 now - last_reply > SILENCE_ALERT_THRESHOLD_SEC（默认 900s = 15min）
// 3. 且距上次告警 > SILENCE_ALERT_COOLDOWN_SEC（默认 3600s = 1h，防刷屏）
// 4. DM 主人：`⚠️ Bot 已沉默 {N} 分钟，最后回复于 {time}`
// 5. Redis 记 `xxb:alert:silence:last` 防重复
```

**env flags:**
```
SILENCE_ALERT_ENABLED=true
SILENCE_ALERT_THRESHOLD_SEC=900
SILENCE_ALERT_COOLDOWN_SEC=3600
SILENCE_ALERT_OWNER_UID=6251541967
```

**last_bot_reply 更新点：** 在 `src/bot/sender/telegram.ts` 的 `sendMessage` 成功后写 Redis timestamp。

### Task 5: 记录 bot 最后回复时间戳

**Files:**
- Modify: `src/bot/sender/telegram.ts` — `sendMessage` 成功后 `redis.set('xxb:metrics:last_bot_reply', Date.now())`

### Task 6: 注册 cron + typecheck + 测试

**Files:**
- Modify: `src/cron/scheduler.ts` — `if (env().SILENCE_ALERT_ENABLED) tasks.push(schedule('*/5 * * * *', runSilenceAlert))`
- Modify: `src/env.ts` — 加 zod schema

```bash
export PATH=/root/.hermes/node/bin:$PATH
npm run typecheck && npm run lint
npm run test
sudo systemctl restart xxb-ts
```

---

## P1-A: Provider 熔断器

**问题：** 当前 cooldown 只处理 429（限流）。timeout / 5xx / 网络错误 / empty content 连续失败时仍每次重试，浪费时间烧 token。

**现状：**
- `src/ai/cooldown.ts` — `CooldownTracker`，Redis key `xxb:cooldown:{model}`，仅 429 触发
- `src/ai/fallback.ts:117-119` — 只在 `AI_RATE_LIMIT` 时 `setCooldown`

### Task 7: 扩展 CooldownTracker 为完整熔断器

**Files:**
- Modify: `src/ai/cooldown.ts`
- Modify: `src/ai/fallback.ts`

**设计：**
```typescript
// cooldown.ts 扩展：
// 新增 Redis key `xxb:circuit:{model}:failures` — 连续失败计数
// 新增 Redis key `xxb:circuit:{model}:tripped` — 熔断状态（TTL）

// 触发条件：
// - 连续失败 N 次（CIRCUIT_FAILURE_THRESHOLD=3）→ 熔断
// - 熔断时长：CIRCUIT_BREAKER_SEC=120（2分钟，指数退避 ×1.5）
// - 熔断期间 isCoolingDown 返回 true，跳过该 provider

// 失败类型：
// - AI_TIMEOUT
// - AI_NETWORK_ERROR
// - AI_HTTP_5XX
// - AI_EMPTY_CONTENT（连续 3 次空内容 → 熔断）
// - AI_RATE_LIMIT（保持现有 60s 冷却）

// 成功时重置失败计数
// 半开状态：熔断到期后允许 1 次试探请求
```

**fallback.ts 修改：**
- 每次失败 → `cooldown.recordFailure(label, errorType)`
- 每次成功 → `cooldown.recordSuccess(label)`
- `isCoolingDown` 检查熔断状态

### Task 8: 加 env flags + 测试

```
CIRCUIT_FAILURE_THRESHOLD=3
CIRCUIT_BREAKER_SEC=120
CIRCUIT_BREAKER_MAX_SEC=1800
```

```bash
export PATH=/root/.hermes/node/bin:$PATH
npm run typecheck && npm run lint && npm run test
```

---

## P1-B: 语音消息

**问题：** bot 纯文字，缺少"活人感"。特定场景发语音（撒娇、吐槽、讲故事）效果质变。

**现状：**
- 无 TTS、无 `sendVoice`
- grammY 原生支持 `bot.api.sendVoice`
- 音频输入转写存在但禁用

### Task 9: 添加 sendVoice 到 telegram sender

**Files:**
- Modify: `src/bot/sender/telegram.ts`

```typescript
// 新增 sendVoice(chatId, voiceBuffer, options?)
// 使用 bot.api.sendVoice(chatId, { source: voiceBuffer }, options)
```

### Task 10: 集成 TTS provider

**Files:**
- Create: `src/ai/tts.ts`

**设计：**
```typescript
// src/ai/tts.ts
// 支持 OpenAI TTS API 格式（兼容 Azure OpenAI TTS / edge-tts / 其他）
// 
// async function synthesizeVoice(text: string, opts?: { voice?: string; speed?: number }): Promise<Buffer>
// 
// env:
// TTS_ENABLED=true
// TTS_ENDPOINT=https://...  (OpenAI-compatible /v1/audio/speech)
// TTS_KEY=...
// TTS_MODEL=tts-1
// TTS_VOICE=alloy
// TTS_FORMAT=ogg  (Telegram 语音消息需要 ogg/opus)
//
// 如果没有 TTS key，fallback 到 edge-tts（免费，本地 Python）
```

**edge-tts fallback（免费方案）：**
```bash
pip install edge-tts
edge-tts --voice zh-CN-XiaoxiaoNeural --text "你好" --write-media /tmp/voice.ogg
```

### Task 11: 回复管线集成语音

**Files:**
- Modify: `src/pipeline/reply/reply.ts`

**设计：**
- 回复 JSON 加可选字段 `"voice": true` — 模型标记这条回复应该用语音发
- 或者在 reply pipeline 后加一层判断：特定场景（短句撒娇、夜间私聊、情绪强烈）自动转语音
- 生成文本 → TTS 合成 → `sendVoice` 发送
- 失败 fallback 到文字发送

```
TTS_ENABLED=true
TTS_VOICE_TRIGGER_ENABLED=true  // 自动判断是否转语音
TTS_VOICE_PROBABILITY=0.15  // 15% 概率随机转语音（避免每次都是语音）
```

### Task 12: 测试 + 重启验证

```bash
export PATH=/root/.hermes/node/bin:$PATH
npm run typecheck && npm run lint && npm run test
sudo systemctl restart xxb-ts
```

---

## P2-A: 主动搭话升级

**问题：** 现有多套主动搭话分散在 idle/proactive-scan/sleep/self-continue，缺乏统一策略和记忆驱动。

**现状：**
- `src/cron/idle.ts` — 群沉默 >60min 随机发一句
- `src/cron/proactive-scan.ts` — LLM 判断"该不该插嘴"
- `src/pipeline/turn/self-continue.ts` — 回复后概率接话
- `src/cron/sleep-cycle.ts` — 早晚安

### Task 13: 记忆驱动主动搭话

**Files:**
- Modify: `src/cron/proactive-scan.ts` 或 `src/cron/idle.ts`

**设计：**
- 在主动搭话前，从 Qdrant 检索跟当前群/时间相关的记忆
- 例如："上次 XX 说要考试" → bot 主动问"考完了吗"
- 时间相关记忆："上次这个群聊到半夜" → 深夜主动冒泡
- 在现有 `generatePersonaProactiveText` prompt 中注入记忆上下文

### Task 14: 统一主动搭话调度

**Files:**
- Create: `src/cron/proactive-coordinator.ts`

**设计：**
- 统一入口决定"现在该不该主动说话、说什么"
- 合并 idle + proactive-scan 的判断逻辑
- 避免多个 cron 同时触发导致 bot 刷屏
- 优先级：self-continue > proactive-scan > idle
- 全局 rate limit：每群每小时最多 N 条主动消息

---

## P2-B: RSS / 信息流监控

**问题：** bot 缺少外部信息感知，不能主动分享有趣内容。

**现状：**
- TG 频道 HTML 抓取（`channel-scraper.ts`）
- 按需 web-fetch（含 Discourse RSS / V2EX）
- 无通用 RSS 周期监控

### Task 15: RSS feed 管理

**Files:**
- Create: `src/cron/rss-monitor.ts`
- Create: `src/pipeline/tools/rss-config.ts`
- Modify: `src/env.ts`, `src/cron/scheduler.ts`

**设计：**
```typescript
// RSS feeds 配置（SQLite 表或 .env）
// rss_feeds 表: id, url, chat_id, last_pub_date, enabled
// 
// 每 30 分钟轮询所有 enabled feeds
// 解析 RSS/Atom (用 fast-xml-parser 或 自写 parser)
// 新条目 → 存入 Redis context → bot 可在主动搭话时引用
// 重要条目 → 直接发到指定群（带 bot 评论）
//
// env:
// RSS_MONITOR_ENABLED=true
// RSS_MONITOR_INTERVAL_MIN=30
// RSS_FEEDS_JSON='[{"url":"...","chatId":-100...,"autoPost":true}]'
```

### Task 16: RSS 内容与主动搭话联动

**Files:**
- Modify: `src/cron/proactive-scan.ts` 或 `proactive-coordinator.ts`

**设计：**
- RSS 新条目作为"谈资"注入主动搭话 prompt
- bot 用自己的风格评论/分享新闻
- 不是 raw 转发，而是"我看到一个有意思的东西…"风格

---

## P3: 四段架构重构

**问题：** Heart/Judge/Reply/Meta/Vision 耦合在 pipeline.ts（1229行），改动牵一发动全身。

**目标：** 拆分为四个独立模块，各自可独立选模型、调优、测试。

**现状：**
- `src/pipeline/pipeline.ts` — 1229 行巨型编排
- Heart 分支 `:659-896` — 一次 persona 调用替代 judge+gate
- Legacy judge `:897-906` — L0→L1→L2
- Reply `src/pipeline/reply/reply.ts` — 1030 行
- Meta `src/meta/` — 已独立但绕过 pipeline
- Vision `src/pipeline/vision.ts` — 已独立

**这是大重构，需要单独的详细计划。** 建议在 P0-P2 完成后，根据实际痛点再决定是否推进。

### 方向：
1. **Heart 独立** — 抽成 `src/pipeline/heart/heart.ts`，输入 messages+context，输出 verdict
2. **Reply 独立** — 已有 `reply.ts`，进一步解耦 prompt-builder
3. **Meta 编排** — 已独立，保持
4. **Vision 独立** — 已独立，保持
5. **pipeline.ts 瘦身** — 只做编排，不包含业务逻辑

---

## 验证清单

每个 Phase 完成后：
- [ ] `npm run typecheck` — 零错误
- [ ] `npm run lint` — 零警告
- [ ] `npm run test` — 全绿
- [ ] `sudo systemctl restart xxb-ts` — 启动日志 6 检查点全通过
- [ ] 实际发消息测试 bot 回复正常
