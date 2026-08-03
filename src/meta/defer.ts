// ────────────────────────────────────────
// Meta 路径 defer 延迟重评（对齐 pipeline/timing/defer.ts 的 MaiBot 语义）
// ────────────────────────────────────────
//
// 老版 pipeline + turn actor 有完整的 defer 机制：gate 冷却/talk-value 未达标时
// 不丢消息，排 BullMQ delayed job 到点带着消息重新走完整评估。Meta 路径是
// Redis-centric 的（不进 BullMQ message 队列），所以这里用 Redis Sorted Set
// 代替 BullMQ delayed job：score = 到期时间戳，metaTick 每轮 drain 到期条目
// 重新 ingest 进 Attention。
//
// 预算复用 TURN_GATE_DEFER_MAX_REPLAYS（默认 1）；延迟范围复用
// DEFER_MIN_DELAY_MS / DEFER_MAX_DELAY_MS。耗尽预算时调用方（evaluateMetaTiming）
// 不再 defer，放行给 LLM 裁决——兜底是"多烧一次 LLM"，不是丢消息。

import { env } from '../env.js';
import { getRedis } from '../db/redis.js';
import { logger } from '../shared/logger.js';
import type { AttentionLayer } from './types.js';

const DEFER_KEY = 'xxb:meta:deferred';

export const META_DEFER_MIN_DELAY_MS = 3_000;
export const META_DEFER_MAX_DELAY_MS = 600_000;

/** 延迟重评条目——存进 Redis ZSET 的 JSON。 */
export interface MetaDeferEntry {
  chatId: number;
  layer: AttentionLayer;
  reason: string;
  messageId?: number;
  userId?: number;
  textPreview?: string;
  pressure?: number;
  payload?: Record<string, unknown>;
  /** 本条已被 defer 的次数（首次为 0，每次 drain 递增）。 */
  deferCount: number;
}

/** 调用方短路层用：该条目是否还有 defer 预算（没有 → 放行给 LLM）。 */
export function hasMetaDeferBudget(deferCount: number | undefined): boolean {
  return (deferCount ?? 0) < env().TURN_GATE_DEFER_MAX_REPLAYS;
}

/**
 * 把被 defer 的消息暂存进 Redis ZSET，到点由 metaTick drain 重新 ingest。
 * 返回 false = 重放预算耗尽（调用方应放行给 LLM，而不是丢弃）。
 */
export async function scheduleMetaDeferReeval(args: {
  chatId: number;
  entry: Omit<MetaDeferEntry, 'deferCount'>;
  deferCount: number;
  retryAfterMs: number;
  reason: string;
}): Promise<boolean> {
  if (!hasMetaDeferBudget(args.deferCount)) {
    logger.info(
      { chatId: args.chatId, deferCount: args.deferCount, reason: args.reason },
      'Meta defer budget exhausted (caller should fall through to LLM)',
    );
    return false;
  }

  const delayMs = Math.min(
    Math.max(args.retryAfterMs, META_DEFER_MIN_DELAY_MS),
    META_DEFER_MAX_DELAY_MS,
  );
  const fireAt = Date.now() + delayMs;
  const stored: MetaDeferEntry = {
    ...args.entry,
    deferCount: args.deferCount + 1,
  };
  const member = JSON.stringify(stored);

  try {
    await getRedis().zadd(DEFER_KEY, fireAt, member);
    logger.info(
      {
        chatId: args.chatId,
        delayMs,
        deferCount: args.deferCount + 1,
        reason: args.reason,
      },
      'Meta defer → Redis ZSET scheduled',
    );
    return true;
  } catch (err) {
    logger.warn({ err, chatId: args.chatId, reason: args.reason }, 'Meta defer ZADD failed — fall through');
    return false;
  }
}

// 原子提取到期条目：ZRANGEBYSCORE + ZREMRANGEBYSCORE 在一个 Lua 脚本里，
// 避免跨进程竞争（多 worker / 多 tick 同时 drain 不会重复提取）。
const DRAIN_DUE_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local items = redis.call('ZRANGEBYSCORE', key, 0, now)
if #items > 0 then
  redis.call('ZREMRANGEBYSCORE', key, 0, now)
end
return items
`;

/**
 * 提取所有到期的 defer 条目（score ≤ now），原子从 ZSET 移除。
 * 未到期或空时返回空数组。
 */
export async function drainDueMetaDefers(now: number = Date.now()): Promise<MetaDeferEntry[]> {
  try {
    const redis = getRedis();
    const raw = (await redis.eval(DRAIN_DUE_LUA, 1, DEFER_KEY, String(now))) as string[];
    if (!raw || raw.length === 0) return [];
    const out: MetaDeferEntry[] = [];
    for (const r of raw) {
      try {
        out.push(JSON.parse(r) as MetaDeferEntry);
      } catch {
        /* drop malformed */
      }
    }
    if (out.length) {
      logger.info({ count: out.length }, 'Meta defer drain: due items extracted');
    }
    return out;
  } catch (err) {
    logger.warn({ err }, 'Meta defer drain failed (non-critical)');
    return [];
  }
}
