// ────────────────────────────────────────
// C 网络事件 burst — 群里集体喊"挂了/CF炸了/502" 时本喵冒一句
// ────────────────────────────────────────
//
// 机场/VPS 群核心话题是线路状态,集体哀嚎是高频场景,此时开口比冷场搭话更
// 自然。30s 滑窗内 ≥5 条消息 → 用一次廉价 LLM 判断这波是不是"集体故障哀嚎"
// (取代原来的关键词正则,能认出"寄了"/"wifi炸了"/打字错这类正则漏掉的说法)。
//
// 设计:
//   - 窗口不再靠内容过滤,任何消息都计数 → 阈值提到 5(原 3)+ 窗口收紧到
//     30s(原 45s),避免普通热聊也频繁触发分类调用。
//   - 命中阈值后**先占坑**(cooldown NX)再判断,防止同一波消息把分类器打爆;
//     LLM 判否 → 把冷却缩短到 2 分钟(NEGATIVE_COOLDOWN_SEC)并清窗,允许
//     很快重新起波检测(不会因一次误判压住后续真故障太久)。
//   - reactive 检测(30s 窗 proactive-scan 5min 抓不到),自带 chat-lock + 作息门。
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
const TEXTS_KEY = (chatId: number): string => `xxb:burst:net:texts:${chatId}`;
const COOLDOWN_KEY = (chatId: number): string => `xxb:burst:cd:${chatId}`;
const WINDOW_SEC = 30;              // 滑窗(收紧:不再靠内容过滤,窗口越短越接近真突发)
const THRESHOLD = 5;                // 窗内 ≥5 条消息(不筛内容,阈值需更高避免误触发分类)
const MAX_TEXTS = 8;                // 喂给分类器的最近消息条数上限
const COOLDOWN_SEC = 600;           // 判定为故障后:10 分钟内不再冒(去重同一波)
const NEGATIVE_COOLDOWN_SEC = 120;  // 判否:2 分钟短冷却,避免同波热聊把分类器打爆,但不压真故障太久

const NET_TROUBLE_SYSTEM_PROMPT =
  '你在看一小段群聊消息(群里常聊机场/VPS/代理/服务器话题)。判断这几条**连续**消息是不是' +
  '群友在集体反映网络/服务器/线路故障(断线、连不上、卡顿、502/503、被墙、丢包、节点或' +
  '机场挂了等),而不是日常聊天、玩梗或讨论其它话题。只输出 JSON:{"trouble": true 或 false}。';

/** 用一次廉价 LLM 判断这批消息是不是"集体故障哀嚎"(取代原关键词正则)。 */
async function classifyNetworkTrouble(texts: string[]): Promise<boolean> {
  if (texts.length === 0) return false;
  try {
    const { callWithFallback } = await import('../../ai/fallback.js');
    const r = await callWithFallback({
      usage: 'judge',
      messages: [
        { role: 'system', content: NET_TROUBLE_SYSTEM_PROMPT },
        { role: 'user', content: texts.map((t, i) => `${i + 1}. ${t.slice(0, 100)}`).join('\n') },
      ],
      maxTokens: 60,
      temperature: 0,
    });
    const raw = r.content.trim();
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end < start) return false;
    const parsed = JSON.parse(raw.slice(start, end + 1)) as { trouble?: boolean };
    return parsed.trouble === true;
  } catch (err) {
    logger.debug({ err }, 'classifyNetworkTrouble failed (non-critical)');
    return false;
  }
}

/**
 * 入站消息触发:计入滑窗;窗内够阈值 + 冷却过 → 用 LLM 判断是否故障 → 冒一句。
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
    const text = (formatted.textContent || formatted.captionContent || '').trim();
    if (!text) return;

    const redis = getRedis();
    // 滑窗计数:zadd(score=now) → 清旧 → zcard;同步记录最近文本供分类器用。
    const key = BURST_KEY(chatId);
    const textsKey = TEXTS_KEY(chatId);
    await redis.zadd(key, nowSec, String(formatted.messageId)).catch(() => {});
    await redis.expire(key, WINDOW_SEC * 2).catch(() => {});
    await redis.zremrangebyscore(key, '-inf', nowSec - WINDOW_SEC).catch(() => {});
    await redis.rpush(textsKey, text.slice(0, 120)).catch(() => {});
    await redis.ltrim(textsKey, -MAX_TEXTS, -1).catch(() => {});
    await redis.expire(textsKey, WINDOW_SEC * 2).catch(() => {});
    const count = await redis.zcard(key).catch(() => 0);
    if (count < THRESHOLD) return;

    // 先占坑(防同一波消息把分类器打爆),再判断是否真是故障。
    const cd = await redis.set(COOLDOWN_KEY(chatId), '1', 'EX', COOLDOWN_SEC, 'NX').catch(() => 'OK');
    if (cd === null) return;
    if (await isAsleep()) return; // 睡觉不凑(夜里故障也别炸群)

    const { isChatSuppressed } = await import('../timing/chat-runtime.js');
    if (await isChatSuppressed(chatId).catch(() => false)) return;

    const recentTexts = await redis.lrange(textsKey, 0, -1).catch(() => [] as string[]);
    const isTrouble = await classifyNetworkTrouble(recentTexts.length > 0 ? recentTexts : [text]);
    if (!isTrouble) {
      // 判否:缩短冷却 + 清窗,允许很快重新起波检测,不压真故障太久。
      await redis.set(COOLDOWN_KEY(chatId), '1', 'EX', NEGATIVE_COOLDOWN_SEC).catch(() => {});
      await redis.del(key).catch(() => {});
      await redis.del(textsKey).catch(() => {});
      return;
    }

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
        await redis.del(textsKey).catch(() => {});
        logger.info({ chatId, count }, 'Network burst: chimed in');
      }
    } finally {
      await release().catch(() => {});
    }
  } catch (err) {
    logger.debug({ err, chatId }, 'maybeNetworkBurst failed (non-critical)');
  }
}
