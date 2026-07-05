// ────────────────────────────────────────
// 「深想」— @bot 的硬技术问题 → 异步 mundo 深答补发
// ────────────────────────────────────────
// bot 的群是 VPS/机场/技术社区,偶有硬技术/代码/算法问题。快模型答这类最弱,
// 而 mundo(深推理)最强但太慢(几分钟)、塞不进同步回复。故:正常回复照常;
// 同时后台丢给 mundo 深想,想好了补发一条「我仔细想了下:…」。
//
// 只对**直接问 bot**(@bot / 回复 bot)且经廉价 LLM 判定为硬技术问题的消息触发
// (低频、用户明确想要、省 mundo 成本)。fire-and-forget,永不抛。
// mundo 失败/超时/空/回退到兜底 → **不补发**(静默降级,绝不用兜底模型冒充深答,
// 也避免和正常回复重复)。默认关(DEEP_THINK_ENABLED),且依赖 MUNDO_ENABLED。

import { getRedis } from '../db/redis.js';
import { sendMessage } from '../bot/sender/telegram.js';
import { addAssistant } from './context/manager.js';
import { isAsleep } from '../tracking/sleep.js';
import { env } from '../env.js';
import { logger } from '../shared/logger.js';
import { callWithFallback } from '../ai/fallback.js';
import { detectDirectInteraction } from './timing/direct-interaction.js';
import type { FormattedMessage, UpdateLike } from '../shared/types.js';

const CD_KEY = (chatId: number): string => `xxb:deepthink:cd:${chatId}`;
const COOLDOWN_SEC = 300;        // per-chat 冷却:最多 5 分钟一次(控噪 + 控 mundo 成本)
const NEG_COOLDOWN_SEC = 60;     // 判否后缩短冷却,别把随后真问题压太久
const MAX_INFLIGHT = 2;          // 全局在飞上限(mundo 慢,防堆积)
let _inflight = 0;

const CLASSIFY_SYS =
  '你在判断群友直接问 bot 的一条消息,是不是「值得花几分钟深度作答的硬技术问题」——' +
  '例如具体的编程/算法/调试/系统/网络/配置难题,需要认真推理才能答好的。' +
  '闲聊、打招呼、玩梗、简单事实查询(X 是什么)、情绪宣泄、一句话就能答的,都**不算**。' +
  '只输出 JSON:{"hard": true 或 false}。';

async function isHardTechnical(text: string): Promise<boolean> {
  try {
    const r = await callWithFallback({
      usage: 'judge', maxTokens: 60, temperature: 0,
      messages: [
        { role: 'system', content: CLASSIFY_SYS },
        { role: 'user', content: text.slice(0, 800) },
      ],
    });
    const m = r.content.match(/\{[\s\S]*\}/);
    if (!m) return false;
    return (JSON.parse(m[0]) as { hard?: boolean }).hard === true;
  } catch {
    return false;
  }
}

/**
 * 入站消息触发:直接问 bot 的硬技术问题 → 后台 mundo 深答补发。
 * fire-and-forget,永不抛。
 */
export async function maybeDeepThink(
  chatId: number,
  update: UpdateLike,
  formatted: FormattedMessage,
  botIdentity: { uid: number; username: string; nicknames: string[] },
): Promise<void> {
  try {
    const e = env();
    if (!e.DEEP_THINK_ENABLED || !e.MUNDO_ENABLED) return;
    if (chatId >= 0 || formatted.isBot) return; // 群聊 only
    const text = (formatted.textContent || formatted.captionContent || '').trim();
    if (text.length < 15) return; // 太短不像真问题

    // 直接问 bot?(@bot / 回复 bot;命令/编辑/私聊不走这里)
    const kind = detectDirectInteraction(update, {
      botUid: botIdentity.uid,
      botUsername: botIdentity.username,
      botNicknames: botIdentity.nicknames,
      editByContentOnly: false,
    });
    if (kind !== 'mention' && kind !== 'reply_to_bot') return;

    if (await isAsleep()) return; // 睡觉不深想

    // 先占坑(NX):未判定前抢冷却,防同一波多条 @ 都触发分类。
    const redis = getRedis();
    const cd = await redis.set(CD_KEY(chatId), '1', 'EX', COOLDOWN_SEC, 'NX').catch(() => null);
    if (cd === null) return;

    // 廉价判定:是不是硬技术问题
    if (!(await isHardTechnical(text))) {
      await redis.set(CD_KEY(chatId), '1', 'EX', NEG_COOLDOWN_SEC).catch(() => {}); // 判否 → 缩短冷却
      return;
    }

    if (_inflight >= MAX_INFLIGHT) return;
    _inflight++;
    try {
      const r = await callWithFallback({
        usage: 'mundo', maxTokens: 16000, // timeout 走 mundo usage 配置(480s)
        messages: [
          {
            role: 'system',
            content:
              '你是群里的技术高手。用户问了个硬技术问题,请给一个准确、有深度、直接可用的回答。' +
              '中文,简洁但到位,别啰嗦别客套。不确定的地方要说明,别硬编。',
          },
          { role: 'user', content: text.slice(0, 4000) },
        ],
      });
      // 只在**确实由 mundo 深答**且内容实在时补发:回退到 stepfun 的不发(避免和
      // 正常回复重复、也不让兜底模型冒充"深答")。
      const ans = r.content.trim();
      if (r.label !== 'mundo' || ans.length < 20) {
        logger.info({ chatId, label: r.label, len: ans.length }, 'deep-think: skip follow-up (no mundo answer)');
        return;
      }
      const body = `我仔细想了下:\n${ans}`.slice(0, 3500);
      const mid = await sendMessage(chatId, body, formatted.messageId);
      if (mid) {
        await addAssistant(chatId, { textContent: body, messageId: mid });
        logger.info({ chatId, uid: formatted.uid, len: ans.length }, 'deep-think: mundo follow-up sent');
      }
    } finally {
      _inflight--;
    }
  } catch (err) {
    logger.debug({ err, chatId }, 'maybeDeepThink failed (non-critical)');
  }
}
