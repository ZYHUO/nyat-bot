// ────────────────────────────────────────
// Sleep Queue — 睡觉期间"值得回但先攒着"的消息队列
// ────────────────────────────────────────
//
// v2 语义:睡觉时 judge 照常工作(有预算),判定 REPLY 的消息不立即回,
// 攒进这里;半夜醒补 1-2 条,大头早上起床后补(每分钟一个 chat 串行,
// 防 TG rate limit)。补回走现成的 wait-resume 回放通道:
//   appendPending({waitReplay, sleepCatchup}) + scheduleTurn —— actor 带
//   完整语境重新走管线,写手仍可 silent 反悔(话题翻篇不硬答)。
//
// 存储:xxb:sleep:pendingq:{chatId} list(JSON),每 chat 保最新 3 条;
// 索引 set xxb:sleep:pendingq:chats 供起床时发现有哪些 chat 欠着回复。

import { getRedis } from '../db/redis.js';
import { logger } from '../shared/logger.js';
import { isTurnActorChat } from '../pipeline/turn/flags.js';
import { isMetaSubagentChat } from '../meta/flags.js';
import type { PendingEntry } from '../pipeline/turn/types.js';

const QKEY = (chatId: number): string => `xxb:sleep:pendingq:${chatId}`;
const INDEX_KEY = 'xxb:sleep:pendingq:chats';
const MAX_PER_CHAT = 8;
const TTL_SEC = 18 * 3600;

export interface SleepPendingItem {
  entry: PendingEntry;
  rule?: string;
  ts: number;
}

export const ADDRESSED_RULES_FOR_PRIORITY = new Set([
  'mention_self', 'mention_self_lookup',
  'reply_to_self', 'reply_to_self_lookup', 'reply_to_self_followup_lookup',
  'private_chat',
]);

/** True if catch-up can replay via turn-actor OR Meta Attention re-ingest. */
export function isSleepReplayableChat(chatId: number): boolean {
  return isTurnActorChat(chatId) || isMetaSubagentChat(chatId);
}

/**
 * 入队一条睡眠欠账。turn-actor 群走 wait-resume；Meta 群起床后 Attention 重投。
 */
export async function pushSleepPending(chatId: number, item: SleepPendingItem): Promise<boolean> {
  if (!isSleepReplayableChat(chatId)) {
    logger.debug({ chatId }, 'Sleep queue: chat not replayable, not queued');
    return false;
  }
  try {
    const redis = getRedis();
    await redis
      .multi()
      .rpush(QKEY(chatId), JSON.stringify(item))
      .ltrim(QKEY(chatId), -MAX_PER_CHAT, -1)
      .expire(QKEY(chatId), TTL_SEC)
      .sadd(INDEX_KEY, String(chatId))
      .expire(INDEX_KEY, TTL_SEC)
      .exec();
    logger.info({ chatId, rule: item.rule }, 'Sleep queue: message stashed for catch-up');
    return true;
  } catch (err) {
    logger.debug({ err, chatId }, 'Sleep queue: push failed (non-critical)');
    return false;
  }
}

/** bot 在该 chat 被吵醒并真的回了话 → 它"看过手机了",欠账清零 */
export async function clearSleepPending(chatId: number): Promise<void> {
  try {
    const redis = getRedis();
    await redis.multi().del(QKEY(chatId)).srem(INDEX_KEY, String(chatId)).exec();
  } catch (err) {
    logger.debug({ err, chatId }, 'Sleep queue: clear failed (non-critical)');
  }
}

export async function listSleepPendingChats(): Promise<number[]> {
  try {
    const raw = await getRedis().smembers(INDEX_KEY);
    return raw.map(Number).filter((n) => !Number.isNaN(n));
  } catch {
    return [];
  }
}

/**
 * 取走某 chat 的**全部**欠账并清空队列(时间序,旧→新)。
 * 曾只返回"最值得补的一条"并销毁其余(48h 实测 52% 欠账被丢):现在
 * 全量交给消费方 —— 补回仍是一个回合一个念头(actor burst 语义),
 * 全部条目进 pending 后写手看得到整段欠账,锚点由消费方挑。
 */
export async function takeSleepPending(chatId: number): Promise<SleepPendingItem[]> {
  try {
    const redis = getRedis();
    const raw = await redis.lrange(QKEY(chatId), 0, -1);
    await clearSleepPending(chatId);
    const items: SleepPendingItem[] = [];
    for (const r of raw) {
      try {
        items.push(JSON.parse(r) as SleepPendingItem);
      } catch {
        /* malformed, drop */
      }
    }
    return items;
  } catch (err) {
    logger.debug({ err, chatId }, 'Sleep queue: take failed');
    return [];
  }
}

/** 队列概览(挑下一个补哪个 chat:有点名的优先,其次最新) */
export async function peekSleepQueues(): Promise<{ chatId: number; lastTs: number; hasAddressed: boolean }[]> {
  const chats = await listSleepPendingChats();
  const out: { chatId: number; lastTs: number; hasAddressed: boolean }[] = [];
  for (const chatId of chats) {
    try {
      const raw = await getRedis().lrange(QKEY(chatId), 0, -1);
      if (raw.length === 0) {
        await getRedis().srem(INDEX_KEY, String(chatId)).catch(() => {});
        continue;
      }
      let lastTs = 0;
      let hasAddressed = false;
      for (const r of raw) {
        try {
          const item = JSON.parse(r) as SleepPendingItem;
          lastTs = Math.max(lastTs, item.ts);
          if (ADDRESSED_RULES_FOR_PRIORITY.has(item.rule ?? '')) hasAddressed = true;
        } catch { /* drop */ }
      }
      out.push({ chatId, lastTs, hasAddressed });
    } catch { /* skip chat */ }
  }
  return out.sort((a, b) =>
    a.hasAddressed !== b.hasAddressed ? (a.hasAddressed ? -1 : 1) : b.lastTs - a.lastTs,
  );
}
