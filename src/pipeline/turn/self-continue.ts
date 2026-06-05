// ────────────────────────────────────────
// Turn Actor — G6 自我接话("对了…"/补贴纸/或者就这样)
// ────────────────────────────────────────
//
// MaiBot 的 tool_continue 语义:发完回复后,循环还活着,模型自己决定
// 要不要再补一拍。我们做有界版:
//   - 概率门(基础 30%)+ 每 chat 冷却(10 分钟)→ 不会变成话痨
//   - 发完等 2-5s 的"人类节拍",期间有新用户消息 → 立刻让位(pending 检查
//     + abort registry,ingress 的 interruptGeneration 可掐死接话生成)
//   - 预算 TURN_SELF_FOLLOWUP_MAX(默认 2),第二拍概率减半
//   - 模型用 {"action":"silent"} 表态"就这样" —— 沉默是预期主路径

import { getRecent, addAssistant } from '../context/manager.js';
import { slimContextForAI } from '../context/slim.js';
import { buildSystemPrompt } from '../reply/prompt-builder.js';
import { callWithFallback } from '../../ai/fallback.js';
import { parseReplyResponse } from '../reply/parser.js';
import { sendMessage, sendChatAction, sendSticker } from '../../bot/sender/telegram.js';
import { getReadyStickersByIntent, recordStickerSent } from '../../knowledge/sticker/store.js';
import { pendingCount } from './buffer.js';
import { getFocus, followupProbability } from './focus.js';
import { registerGeneration, clearGeneration } from './abort-registry.js';
import { recordBotReply as recordTimingBotReply } from '../timing/state-store.js';
import { getRedis } from '../../db/redis.js';
import { AIError } from '../../shared/errors.js';
import { env } from '../../env.js';
import { logger } from '../../shared/logger.js';

const FOLLOWUP_BASE_PROBABILITY = 0.3;
const FOLLOWUP_COOLDOWN_SEC = 600;
const BEAT_MIN_MS = 2000;
const BEAT_MAX_MS = 5000;

const COOLDOWN_KEY = (chatId: number) => `xxb:turn:followup:${chatId}`;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 新用户消息在路上/缓冲里 → 接话让位 */
async function shouldYield(chatId: number): Promise<boolean> {
  try {
    return (await pendingCount(chatId)) > 0;
  } catch {
    return true; // 看不清就让位,宁可少说
  }
}

/**
 * Maybe send a bounded self-continuation after the bot just spoke.
 * Fire-and-forget — never throws.
 */
export async function maybeSelfContinue(chatId: number, botUid: number): Promise<void> {
  const e = env();
  if (!e.TURN_SELF_FOLLOWUP_ENABLED || chatId >= 0) return;
  // G9: focus 调制接话欲(锁定对话 → 更愿意补一拍)
  const probability = e.TURN_FOCUS_ENABLED
    ? followupProbability(await getFocus(chatId))
    : FOLLOWUP_BASE_PROBABILITY;
  if (Math.random() >= probability) return;

  const redis = getRedis();
  // 冷却检查(只读;真正发出后才写,避免白白烧冷却)
  if (await redis.get(COOLDOWN_KEY(chatId))) return;

  const maxRounds = Math.min(Math.max(e.TURN_SELF_FOLLOWUP_MAX, 0), 3);
  let continueProbability = 1; // 第一拍已过基础概率门;后续拍减半

  for (let round = 0; round < maxRounds; round++) {
    if (Math.random() >= continueProbability) return;
    continueProbability *= 0.5;

    // 人类节拍:发完一句,过一两秒才想起"对了…"
    await sleep(BEAT_MIN_MS + Math.random() * (BEAT_MAX_MS - BEAT_MIN_MS));
    if (await shouldYield(chatId)) return;

    const recent = await getRecent(chatId, 15);
    if (recent.length === 0) return;
    const current = recent.at(-1)!;
    // 自我接话的前提:最后一条还是自己说的(没人接茬)
    if (!(current.role === 'assistant' || current.uid === botUid)) return;

    const contextStr = slimContextForAI(recent.slice(0, -1), current, botUid);
    const systemPrompt = buildSystemPrompt('normal', undefined, chatId);
    const userMsg =
      `[群聊上下文]\n${contextStr}\n\n` +
      `[自我接话判断] 上面最后那（几）条是你自己刚发的，现在还没有人接话。` +
      `你要不要自然地补一拍？比如"对了…"式的补充、一句自我吐槽、或一张贴纸` +
      `（{"action":"sticker","stickerIntent":["..."]}）。\n` +
      `**大多数情况下正确答案是 {"action":"silent"}** —— 真人不会总是自言自语；` +
      `只有当刚才的话明显没说完、或你真的还有一句值得说的时才补。\n` +
      `要补的话最多 1 条短消息（不超过50字）或 1 张贴纸，输出 JSON。`;

    const controller = registerGeneration(chatId, 0);
    let content: string;
    try {
      const result = await callWithFallback({
        usage: 'reply',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMsg },
        ],
        maxTokens: 300,
        temperature: 0.9,
        signal: controller.signal,
      });
      content = result.content;
    } catch (err) {
      if (err instanceof AIError && err.code === 'AI_ABORTED') {
        logger.debug({ chatId }, 'Self-continuation interrupted by new message, yielding');
      } else {
        logger.debug({ err, chatId }, 'Self-continuation LLM failed (non-critical)');
      }
      clearGeneration(chatId, controller, true);
      return;
    }
    clearGeneration(chatId, controller, false);

    const parsed = parseReplyResponse(content, current.messageId);
    const speakable = parsed.filter((p) => !p.action || p.action === 'reply' || p.action === 'sticker');
    if (speakable.length === 0 || parsed.some((p) => p.action === 'silent')) {
      logger.debug({ chatId, round }, 'Self-continuation: model chose silence');
      return;
    }

    // 生成期间有人说话 → 让位(真回复永远优先于自我接话)
    if (await shouldYield(chatId)) return;

    const item = speakable[0]!;
    try {
      if (item.action === 'sticker' || item.replyContent.trim() === '[sticker]') {
        const candidates = getReadyStickersByIntent(item.stickerIntent ?? []);
        if (candidates.length === 0) return;
        candidates.sort((a, b) => b.score - a.score);
        const picked = candidates[Math.floor(Math.random() * Math.min(candidates.length, 5))]!;
        const msgId = await sendSticker(chatId, picked.fileId);
        if (msgId) {
          recordStickerSent(chatId, msgId, picked.fileUniqueId, picked.fileId, item.stickerIntent?.[0]);
          await addAssistant(chatId, { textContent: '[sticker]', messageId: msgId });
        }
      } else {
        const text = item.replyContent.slice(0, 200);
        await sendChatAction(chatId, 'typing');
        await sleep(Math.min(text.length * 60, 1200));
        const msgId = await sendMessage(chatId, text);
        if (msgId) {
          await addAssistant(chatId, { textContent: text, messageId: msgId });
        }
      }
      await redis.set(COOLDOWN_KEY(chatId), '1', 'EX', FOLLOWUP_COOLDOWN_SEC);
      void recordTimingBotReply(chatId).catch(() => {});
      logger.info({ chatId, round, kind: item.action ?? 'reply' }, 'Self-continuation sent');
    } catch (err) {
      logger.debug({ err, chatId }, 'Self-continuation send failed (non-critical)');
      return;
    }
  }
}
