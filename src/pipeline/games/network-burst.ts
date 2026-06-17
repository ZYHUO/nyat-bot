// ────────────────────────────────────────
// C 网络事件 burst — 群里集体喊"挂了/CF炸了/502" 时本喵冒一句
// ────────────────────────────────────────
//
// 机场/VPS 群核心话题是线路状态,集体哀嚎是高频场景,此时开口比冷场搭话更
// 自然。30s 滑窗内 ≥3 条"故障"消息 → 冒一句("又炸了?本喵瞅瞅喵")。
//
// 设计(三家 sign-off):
//   - **短语级关键词**(qoder:"CF炸了"非裸"CF",防 502=门牌号误报)。
//   - reactive 检测(30s 窗 proactive-scan 5min 抓不到),但自带 5min 冷却(去重
//     同一故障)+ chat-lock + 作息门 → 满足"别双触发/过门"。
//   - 命中即冒一句走人格管线(可 silent),不走 judge。

import { getRedis } from '../../db/redis.js';
import { acquireChatLock } from '../../queue/chat-lock.js';
import { sendMessage } from '../../bot/sender/telegram.js';
import { addAssistant } from '../context/manager.js';
import { isAsleep } from '../../tracking/sleep.js';
import { env } from '../../env.js';
import { logger } from '../../shared/logger.js';
import type { FormattedMessage } from '../../shared/types.js';

const BURST_KEY = (chatId: number): string => `xxb:burst:net:${chatId}`;
const COOLDOWN_KEY = (chatId: number): string => `xxb:burst:cd:${chatId}`;
const WINDOW_SEC = 45;             // 滑窗
const THRESHOLD = 3;              // 窗内 ≥3 条故障消息
const COOLDOWN_SEC = 600;         // 同群 10 分钟最多冒一次(去重同一波故障)

// 短语级:故障词,且多带"了/炸/挂/崩"等动作语境,避免裸数字/缩写误报
const NET_BURST_RE =
  /(挂了|崩了|炸了|掉线|断线|断了|连不上|上不去|进不去|登不上|跑路了?|被墙了?|限速|严重丢包|50[23]\s*(了|错误|挂|炸|崩|bad|gateway)|cf.{0,4}(炸|挂|崩|抽风)|节点.{0,4}(挂|崩|炸|没)|机场.{0,4}(挂|崩|炸|跑)|线路.{0,4}(挂|崩|炸|抽))/i;

export function looksLikeNetworkTrouble(text: string): boolean {
  return !!text && NET_BURST_RE.test(text);
}

/**
 * 入站消息触发:命中故障词则计入滑窗;窗内够阈值 + 冷却过 → 冒一句。
 * fire-and-forget,永不抛。需要 nowSec 注入以便测试(默认当前)。
 */
export async function maybeNetworkBurst(
  chatId: number,
  formatted: FormattedMessage,
  botUid: number,
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<void> {
  try {
    if (!env().NETWORK_BURST_ENABLED || chatId >= 0 || formatted.isBot) return;
    const text = formatted.textContent || formatted.captionContent || '';
    if (!looksLikeNetworkTrouble(text)) return;

    const redis = getRedis();
    // 滑窗计数:zadd(score=now) → 清旧 → zcard
    const key = BURST_KEY(chatId);
    await redis.zadd(key, nowSec, String(formatted.messageId)).catch(() => {});
    await redis.expire(key, WINDOW_SEC * 2).catch(() => {});
    await redis.zremrangebyscore(key, '-inf', nowSec - WINDOW_SEC).catch(() => {});
    const count = await redis.zcard(key).catch(() => 0);
    if (count < THRESHOLD) return;

    // 冷却(去重同一波故障)
    const cd = await redis.set(COOLDOWN_KEY(chatId), '1', 'EX', COOLDOWN_SEC, 'NX').catch(() => 'OK');
    if (cd === null) return;
    if (await isAsleep()) return; // 睡觉不凑(夜里故障也别炸群)

    const { isChatSuppressed } = await import('../timing/chat-runtime.js');
    if (await isChatSuppressed(chatId).catch(() => false)) return;

    const intent =
      `[网络故障] 群里好几个人在说挂了/炸了/连不上(最近一句:「${text.slice(0, 60)}」)。你可以冒一句——` +
      `确认一下"又炸了?"、调侃、或建议等等/换个节点。一句话,别长篇,别复述他们的话。`;
    const { generatePersonaProactiveText } = await import('../turn/proactive-turn.js');
    const reply = await generatePersonaProactiveText(chatId, botUid, intent);
    if (!reply) return;

    const release = await acquireChatLock(chatId);
    try {
      const mid = await sendMessage(chatId, reply.slice(0, 200));
      if (mid) {
        await addAssistant(chatId, { textContent: reply.slice(0, 200), messageId: mid });
        await redis.del(key).catch(() => {}); // 冒过了清窗,别立刻又触发
        logger.info({ chatId, count }, 'Network burst: chimed in');
      }
    } finally {
      await release().catch(() => {});
    }
  } catch (err) {
    logger.debug({ err, chatId }, 'maybeNetworkBurst failed (non-critical)');
  }
}
