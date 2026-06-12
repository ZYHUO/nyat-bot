// ────────────────────────────────────────
// Speech Meter — bot 自己的发言计数(按北京日)
// ────────────────────────────────────────
//
// 动态就寝的"累"度量(v2 评审共识:用 bot 自己的发送数,不用全群消息量
// ——猫娘的累是"自己话说多了",潜水一天反而精神好)。
// 计数在 sendMessage 低层埋点,包含少量仪式/功能句(晚安、签到确认等);
// 阈值是 30/100/200 量级,几条污染不影响档位,不做排除清单。

import { getRedis } from '../db/redis.js';

const KEY = (d: string): string => `xxb:speech:${d}`;
const TTL_SEC = 3 * 86400;

/** 北京日期字符串(UTC+8 固定,与 life-state 的作息表同日历) */
export function bjDateStr(now: Date = new Date()): string {
  return new Date(now.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
}

/** 记一次发言(fire-and-forget,永不抛) */
export function recordSpeech(now: Date = new Date()): void {
  const key = KEY(bjDateStr(now));
  const redis = getRedis();
  redis
    .incr(key)
    .then((n) => {
      if (n === 1) return redis.expire(key, TTL_SEC).then(() => undefined);
      return undefined;
    })
    .catch(() => {});
}

/** 今天 + 昨天(北京日)的发言数;Redis 故障 fail-soft 返回 0 */
export async function getSpeechCounts(
  now: Date = new Date(),
): Promise<{ today: number; prev: number; todayDate: string; prevDate: string }> {
  const todayDate = bjDateStr(now);
  const prevDate = bjDateStr(new Date(now.getTime() - 86400_000));
  try {
    const redis = getRedis();
    const [t, p] = await redis.mget(KEY(todayDate), KEY(prevDate));
    return { today: Number(t ?? 0), prev: Number(p ?? 0), todayDate, prevDate };
  } catch {
    return { today: 0, prev: 0, todayDate, prevDate };
  }
}

// 阶梯:话少 → 晚睡;话多 → 早睡(分钟,正=推迟就寝)
export function bedtimeShiftFromCount(count: number): number {
  if (count < 30) return 45;    // 今天没怎么说话,精神得很,熬一会
  if (count < 100) return 0;    // 正常
  if (count < 200) return -30;  // 说得不少,有点乏
  return -60;                   // 话痨了一天,早点睡
}
