// ────────────────────────────────────────
// 活跃时段 + 活跃群发现（原 proactive-scan.ts 的残留公共函数）
//
// proactive-scan / idle / proactive-thinker / self-play / goal-check 五个
// 决策型 cron 已被 unified-tick 取代并删除；只有本文件的两个函数还被复用
// （isWithinActiveHours → unified-tick；discoverActiveGroupChats → topic-scan）。
// ────────────────────────────────────────

import { getRedis } from '../db/redis.js';
import { logger } from '../shared/logger.js';

/** 当前北京时间小时是否落在 [start, end) 活跃时段。 */
export function isWithinActiveHours(start: number, end: number): boolean {
  const hour = parseInt(
    new Date().toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', hour12: false }),
    10,
  );
  return hour >= start && hour < end;
}

const GROUPS_ZSET = 'xxb:active_groups';

/** 从活跃群 zset 发现 group chat ids（负数 chatId）。Redis 挂返回空数组。
 * zset key 与 pipeline/context/manager.ts 写入的活跃群索引保持一致——原
 * proactive-scan.ts 的 discoverActiveGroupChats 实现就是从该 key 读出的。 */
export async function discoverActiveGroupChats(): Promise<number[]> {
  try {
    const raw = await getRedis().zrange(GROUPS_ZSET, 0, -1);
    return raw.map((s) => Number(s)).filter((n) => Number.isFinite(n) && n < 0);
  } catch (err) {
    logger.debug({ err }, 'discoverActiveGroupChats failed');
    return [];
  }
}

