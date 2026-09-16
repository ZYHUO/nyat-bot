# AGI 完整化实施计划 (2026-08-06)

> **For Hermes:** 按 P0 → Code Review → P1 → P2 增量执行。每阶段完成后独立验证 + 部署。

**Goal:** 把 NyatBot 从"聊天 bot"升级为具备 交付能力 / 拟人表达 / 自主性 的 AGI agent。

**Architecture:** 三层递进——
- **P0 交付能力**: CodeAct 能把自己做的文件发给用户（消除"说了不做/做了看不到"断点）
- **P1 拟人表达**: 模型自然使用 sticker + 语音（真人感的表达通道）
- **P2 自主性**: 主动搭话从规则驱动升级为模型自主决策

**Tech Stack:** grammY (Telegram API), edge-tts (TTS), CodeAct (sandbox), BullMQ/Redis

---

## P0 — 交付能力（体验断点）

### Task P0-1: telegram.ts 加 sendFile（sendDocument）

**Objective:** CodeAct 能把沙盒文件作为文档发给用户。

**Files:**
- Modify: `src/bot/sender/telegram.ts`（加 `sendFile` 导出函数）
- Test: `tests/unit/bot/sender/telegram.test.ts`（若存在则追加，否则新建）

**实现要点：**
- 用 `bot.api.sendDocument(chatId, new InputFile(buffer, filename), { caption, reply_parameters, message_thread_id })`
- 非幂等（同 sendMessage），网络错误不重试
- 返回 `{ messageId }`
- caption 用纯文本（文件 caption 不支持 MarkdownV2 复杂解析，直接传）

```typescript
/**
 * Send a file (document) to a chat — used by CodeAct to deliver sandbox artifacts.
 * Non-idempotent: no retry on transient network errors (may already be delivered).
 */
export async function sendFile(
  chatId: number,
  filePath: string,
  opts: { caption?: string; replyToId?: number; messageThreadId?: number; filename?: string } = {},
): Promise<{ messageId: number }> {
  const { InputFile } = await import('grammy');
  const { readFile, stat } = await import('node:fs/promises');
  const { basename } = await import('node:path');

  const fstat = await stat(filePath);
  if (!fstat.isFile()) throw new Error(`sendFile: not a file: ${filePath}`);
  if (fstat.size > 50 * 1024 * 1024) throw new Error(`sendFile: too large (${fstat.size} bytes)`);

  const buffer = await readFile(filePath);
  const filename = opts.filename ?? basename(filePath);
  const bot = getBot();
  const anchor = typeof opts.replyToId === 'number' && opts.replyToId > 0 ? opts.replyToId : undefined;
  const threadId = typeof opts.messageThreadId === 'number' && opts.messageThreadId > 1 ? opts.messageThreadId : undefined;

  try {
    const result = await bot.api.sendDocument(chatId, new InputFile(buffer, filename), {
      caption: opts.caption ? opts.caption.slice(0, 1000) : undefined,
      reply_parameters: anchor ? { message_id: anchor, allow_sending_without_reply: true as const } : undefined,
      message_thread_id: threadId,
    });
    return { messageId: result.message_id };
  } catch (err) {
    logger.warn({ err, chatId, filename }, 'sendFile failed');
    throw err;
  }
}
```

**验证:** `npm run typecheck` + 相关测试；部署后 CodeAct 里 `telegram.sendFile(...)` 能发文件。

### Task P0-2: host-api.ts 加 telegram.sendFile

**Objective:** CodeAct 全局对象暴露 `telegram.sendFile(path, caption?)`。

**Files:**
- Modify: `src/subagent/host-api.ts`
  - `HostApi.telegram` 接口加 `sendFile: (path: string, caption?: string) => Promise<{ messageId: number }>`
  - 实现：路径必须先经 `resolveInsideSandbox` 校验（禁止逃逸），再调 `sendFile` 发送
  - 发送后 `addAssistant(chatId, { textContent: '[file] ' + filename, messageId })` 记录到上下文

```typescript
async sendFile(path: string, caption?: string) {
  assertOpen();
  const { resolveInsideSandbox } = await import('../sandbox/paths.js');
  const { sendFile: tgSendFile } = await import('../bot/sender/telegram.js');
  const target = resolveInsideSandbox(String(path)); // throws on path escape
  const messageId = await tgSendFile(chatId, target, {
    caption: caption ? String(caption).slice(0, 1000) : undefined,
    replyToId: defaultReplyTo,
    messageThreadId: opts.messageThreadId,
  });
  return { messageId };
}
```

**验证:** typecheck；日志确认 `[file]` 记录进上下文。

### Task P0-3: EXECUTOR_SYSTEM prompt 加交付规则

**Objective:** 模型知道"做完必须交付文件"。

**Files:**
- Modify: `src/subagent/executor.ts` EXECUTOR_SYSTEM

在"行为准则"第 1 条后加：
```
- 如果创建了文件（写代码/HTML/脚本等）→ **必须用 telegram.sendFile(path, caption) 把文件发给用户**，再 sendText 说明。文件路径用相对沙盒路径（如 "snake.html"），caption 用一句话说明这是什么。
```

**验证:** 部署后发"写个贪吃蛇给我"→ bot 实际发一个 HTML 文件回来。

### Task P0-4: sandbox/files.ts 支持二进制 + 返回相对路径

**Objective:** 支持写 HTML/PNG 等文件时用二进制安全写；sandboxWriteFile 返回沙盒相对路径。

**Files:**
- Modify: `src/sandbox/files.ts`
  - `sandboxWriteFile` 保持文本（code 场景），新增 `sandboxWriteBinary(path, buffer)`
  - 返回 `{ ok, path: 相对沙盒根的路径 }`（现在是绝对路径，模型直接拿去 sendFile 会炸）

**验证:** typecheck + 单测。

---

## P1 — 拟人表达

### Task P1-1: prompt 教模型自然用 sticker

**Objective:** 群聊/私聊回复时，情绪合适先丢 sticker 再接话。

**Files:**
- Modify: `src/subagent/executor.ts` EXECUTOR_SYSTEM

在行为准则加：
```
- 群聊回复前，如果情绪合适（打招呼/开心/傲娇/犯困等），先 `stickers.pick(mood)` 拿一个 sticker 用 `telegram.sendSticker` 发出去，再接文字。私聊慎用。
```

**验证:** 部署后闲聊时 bot 偶尔会带 sticker。

### Task P1-2: telegram.ts 加 sendVoice（TTS 语音）

**Objective:** CodeAct 能用 TTS 合成语音发出去。

**Files:**
- Modify: `src/bot/sender/telegram.ts` 加 `sendVoice(chatId, oggBuffer, opts)`
- Modify: `src/ai/tts.ts` 确认 `synthesizeVoice` 已导出（已存在）

```typescript
/** Send an OGG/Opus voice message (from TTS). Non-idempotent. */
export async function sendVoice(
  chatId: number,
  oggBuffer: Buffer,
  opts: { replyToId?: number; messageThreadId?: number } = {},
): Promise<{ messageId: number }> {
  const { InputFile } = await import('grammy');
  const bot = getBot();
  const anchor = typeof opts.replyToId === 'number' && opts.replyToId > 0 ? opts.replyToId : undefined;
  const threadId = typeof opts.messageThreadId === 'number' && opts.messageThreadId > 1 ? opts.messageThreadId : undefined;
  const result = await bot.api.sendVoice(chatId, new InputFile(oggBuffer, 'voice.ogg'), {
    reply_parameters: anchor ? { message_id: anchor, allow_sending_without_reply: true as const } : undefined,
    message_thread_id: threadId,
  });
  return { messageId: result.message_id };
}
```

**验证:** typecheck；`synthesizeVoice` + `sendVoice` 链路手动 curl 测通。

### Task P1-3: host-api.ts 加 telegram.sendVoice

**Objective:** CodeAct 暴露 `telegram.sendVoice(text)` — 内部走 synthesizeVoice → sendVoice，失败自动回退文字。

```typescript
async sendVoice(text: string) {
  assertOpen();
  const { synthesizeVoice } = await import('../ai/tts.js');
  const { sendVoice: tgSendVoice } = await import('../bot/sender/telegram.js');
  const ogg = await synthesizeVoice(String(text).slice(0, 500));
  if (!ogg) return { skipped: true, reason: 'tts_disabled' };
  const { messageId } = await tgSendVoice(chatId, ogg, {
    replyToId: defaultReplyTo,
    messageThreadId: opts.messageThreadId,
  });
  return { messageId };
}
```

**验证:** typecheck；TTS_ENABLED=true 后 CodeAct 能发语音。

### Task P1-4: prompt 加语音规则 + TTS_ENABLED 检查

**Objective:** 模型知道何时该用语音；env 默认关不浪费调用。

**Files:**
- Modify: `src/subagent/executor.ts` EXECUTOR_SYSTEM
- 规则：`TTS_ENABLED` 时，道晚安/撒娇/重要情绪表达可 `telegram.sendVoice`；失败自动回退文字不用管

**验证:** typecheck。

---

## P2 — 自主性（真 AGI 核心）

### Task P2-1: 主动搭话模型化 — 新模块 proactive-thinker.ts

**Objective:** 让模型自主决定"现在该不该主动说话、说什么"，替代纯规则。

**Files:**
- Create: `src/cron/proactive-thinker.ts`
- Modify: `src/cron/scheduler.ts`（注册 cron）
- Modify: `src/env.ts`（PROACTIVE_THINKER_ENABLED / INTERVAL）

**设计：**
- cron 每 `PROACTIVE_THINKER_INTERVAL_MIN`（默认 30）跑一次
- 对每个活跃群 + 主人 DM：拉最近上下文 + 沉默时长 + 当前时段
- 调 LLM（`PROACTIVE_USAGE`，默认 judge）问："这个群沉默 X 分钟了，现在是 Y 时段，最近聊的是 Z。该主动说一句吗？说什么？" 输出 `{ speak: bool, text: string }`
- `speak: false` → 跳过；`speak: true` → 经 `tryAcquireProactiveSlot`（防刷屏锁）→ 发消息
- 复用 `proactive-coordinator.ts` 的 Redis 锁 + 每小时上限

**与旧 idle.ts 关系:** idle.ts 保留（群沉默兜底），proactive-thinker 是"模型自主版"，两套都走 coordinator 锁不会互刷。

**验证:** 部署后观察日志出现 `proactive-thinker` 决策记录；群沉默时模型会自然搭话。

### Task P2-2: 主人 DM 主动关心

**Objective:** 对主人 DM 也启用自主搭话（问候/关心/汇报）。

**Files:**
- Modify: `src/cron/proactive-thinker.ts`（DM 分支：chatId > 0 且 = MASTER_UID）

**验证:** 部署后主人长时间没说话，bot 会主动关心。

### Task P2-3: 途中阻碍 AGI 的重构

**Objective:** 执行中发现任何阻碍 AGI 实现的旧架构/死代码/矛盾 prompt，全部重构。

**已知候选：**
- `CODEACT_MAX_TURNS` env 默认值（统一 30 后 env 已不再被 executor 使用，清理注释）
- `DispatchTask.mode/maxTurns/timeoutMs` 残留字段（已从调用点移除，types 里可删）
- nyat-bot-ops skill 的 Work Mode 章节过时（记录的是已删除的关键词方案）→ 更新 skill

**验证:** typecheck + lint + 全量测试绿。

---

## 验证与部署（每阶段完成后）

```bash
export PATH=/root/.hermes/node/bin:$PATH && cd /root/xxb-ts
npm run typecheck && npm run lint && npm run test   # 全绿
npm run build && sudo systemctl restart xxb-ts       # 部署
tail -c 3000 logs/app.log | strings | grep -aiE "error|fatal"  # 无新错误
```

## 验收标准（全部达成 = 完整 AGI）

1. 说"写个贪吃蛇给我" → 收到实际 HTML 文件 📄
2. 闲聊时自然带 sticker / 语音 🎭
3. 群沉默时模型自主决定主动搭话 💬
4. 主人长时间没消息，bot 主动关心 💌
5. 途中无阻碍重构残留（typecheck/lint/test 全绿）
