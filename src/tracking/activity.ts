// ────────────────────────────────────────
// GroupActivityTracker — Redis Sorted Set
// Port of PHP GroupActivityTracker
// ────────────────────────────────────────

import { getRedis } from '../db/redis.js';
import { logger } from '../shared/logger.js';
import type { ActivitySummary } from './types.js';

const KEY_PREFIX = 'xxb:activity:';
const MAX_RETENTION = 3600; // 1 hour

export async function recordMessage(chatId: number, messageId: number, userId?: number): Promise<void> {
  const redis = getRedis();
  const key = KEY_PREFIX + chatId;
  const now = Math.floor(Date.now() / 1000);
  const member = `${messageId}:${userId ?? 0}`;

  try {
    const pipeline = redis.pipeline();
    pipeline.zadd(key, now, member);
    pipeline.zremrangebyscore(key, '-inf', String(now - MAX_RETENTION));
    pipeline.expire(key, MAX_RETENTION + 60);
    await pipeline.exec();
  } catch (err) {
    logger.warn({ err, chatId }, 'GroupActivityTracker: record failed');
  }
}

export async function getActivitySummary(chatId: number): Promise<ActivitySummary> {
  const redis = getRedis();
  const key = KEY_PREFIX + chatId;
  const now = Math.floor(Date.now() / 1000);

  try {
    await redis.zremrangebyscore(key, '-inf', String(now - MAX_RETENTION));

    const [last1min, last5min, last15min, last1hour, recentMembers] = await Promise.all([
      redis.zcount(key, String(now - 60), '+inf'),
      redis.zcount(key, String(now - 300), '+inf'),
      redis.zcount(key, String(now - 900), '+inf'),
      redis.zcount(key, String(now - 3600), '+inf'),
      redis.zrangebyscore(key, String(now - 300), '+inf'),
    ]);

    const activeUsers = new Set<number>();
    for (const member of recentMembers) {
      const uid = parseInt(member.split(':')[1] ?? '0', 10);
      if (uid > 0) activeUsers.add(uid);
    }

    return {
      messages1min: last1min,
      messages5min: last5min,
      messages15min: last15min,
      messages1hour: last1hour,
      activeUsers5min: activeUsers.size,
      activityLevel: classifyActivity(last5min),
    };
  } catch (err) {
    logger.warn({ err, chatId }, 'GroupActivityTracker: summary failed');
    return emptyStats();
  }
}

export async function getActivityDescription(chatId: number): Promise<string> {
  const stats = await getActivitySummary(chatId);
  return `[群活跃度: ${stats.activityLevel}] 最近1分钟${stats.messages1min}条, 5分钟${stats.messages5min}条, ${stats.activeUsers5min}人活跃`;
}

/**
 * P1-C:最近 windowSec 秒内消息的时间戳(epoch 秒,升序)。talk_value 空闲
 * 补偿用(平均消息间隔估计)。窗口受 zset 保留期(1h)天然限制。
 */
export async function getRecentTimestamps(chatId: number, windowSec: number): Promise<number[]> {
  const redis = getRedis();
  const key = KEY_PREFIX + chatId;
  const now = Math.floor(Date.now() / 1000);
  try {
    const flat = await redis.zrangebyscore(key, String(now - windowSec), '+inf', 'WITHSCORES');
    const out: number[] = [];
    // WITHSCORES 返回 [member, score, member, score, ...],取奇数位分数
    for (let i = 1; i < flat.length; i += 2) {
      const n = Number(flat[i]);
      if (Number.isFinite(n)) out.push(n);
    }
    return out;
  } catch (err) {
    logger.debug({ err, chatId }, 'getRecentTimestamps failed (non-critical)');
    return [];
  }
}

export function classifyActivity(msg5min: number): ActivitySummary['activityLevel'] {
  if (msg5min >= 20) return '热聊';
  if (msg5min >= 10) return '活跃';
  if (msg5min >= 3) return '正常';
  if (msg5min >= 1) return '冷清';
  return '沉寂';
}

function emptyStats(): ActivitySummary {
  return {
    messages1min: 0,
    messages5min: 0,
    messages15min: 0,
    messages1hour: 0,
    activeUsers5min: 0,
    activityLevel: '沉寂',
  };
}
