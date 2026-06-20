// ────────────────────────────────────────
// Chat attention pressure — 借鉴 CyberGroupmate 的 Attention Accumulator
// ────────────────────────────────────────
//
// 主动扫群以前是「随机洗牌挑几个群」。改成按 pressure 排序挑 Top-N:
//   pressure = volume(活跃度) × intimacy(在场群友亲密度) × hunger(越久没理越想瞄) × ignoredPenalty(老被晾着就别再缠)
// 让 bot「瞄最值得开口的 2-3 个房间」:偏向熟人安静聊天,压制陌生人刷屏;
// 而且同一个被反复跳过的群不会一直来烦(ignored 累积 → pressure 衰减,hunger 又保证冷而亲密的群最终会浮上来)。

import { getRecent } from '../pipeline/context/manager.js';
import { getRelationship } from './relationship.js';
import { getRedis } from '../db/redis.js';

const IGNORED_PREFIX = 'xxb:pressure:ignored:'; // 连续「瞄了但没开口」次数
const LAST_ATTN_PREFIX = 'xxb:proactive:last:'; // 复用现有的「上次主动开口」秒级时间戳
const IGNORED_TTL_SEC = 6 * 3600;

export interface PressureScore {
  chatId: number;
  pressure: number;
  volume: number;
  intimacy: number;
  hunger: number;
  ignoredPenalty: number;
}

/** 单群压力分。纯算术,数据全用现有来源,无新存储(ignored 计数除外)。 */
export async function calculatePressure(chatId: number): Promise<PressureScore> {
  const recent = await getRecent(chatId, 30).catch(() => []);
  const humans = recent.filter((m) => !m.isBot && m.role !== 'assistant');
  const count = humans.length;
  const avgChars = count
    ? Math.min(humans.reduce((s, m) => s + ((m.textContent || m.captionContent || '').length), 0) / count, 200)
    : 0;
  // volume: 条数 × (0.5~1.5 长度权重) —— 短消息刷屏不如有内容的对话值钱
  const volume = count * (0.5 + avgChars / 200);

  // intimacy: 在场群友里最高好感(Dunbar 亲密度),1.0(陌生)~2.0(挚友)
  let maxAff = 0;
  for (const uid of new Set(humans.map((m) => m.uid))) {
    try {
      const a = getRelationship(chatId, uid).affinity;
      if (a > maxAff) maxAff = a;
    } catch { /* non-critical */ }
  }
  const intimacy = 1 + Math.max(0, maxAff) / 100;

  const redis = getRedis();
  // hunger: 越久没主动理这个群,越想瞄一眼(封顶 3 小时 → +0.9)
  const lastRaw = await redis.get(LAST_ATTN_PREFIX + chatId).catch(() => null);
  const lastSec = lastRaw ? parseInt(lastRaw, 10) : 0;
  const minsSince = lastSec ? (Date.now() / 1000 - lastSec) / 60 : 180;
  const hunger = 1 + Math.min(minsSince / 60, 3) * 0.3;

  // ignoredPenalty: 连续瞄了却没开口 → 逐次打折,地板 0.3(别一直缠着同一个不想接的群)
  const ignoredRaw = await redis.get(IGNORED_PREFIX + chatId).catch(() => null);
  const ignored = ignoredRaw ? parseInt(ignoredRaw, 10) : 0;
  const ignoredPenalty = Math.max(0.3, 1 - ignored * 0.25);

  return { chatId, pressure: volume * intimacy * hunger * ignoredPenalty, volume, intimacy, hunger, ignoredPenalty };
}

/** 按 pressure 排序取 Top-N(替代随机挑选)。 */
export async function rankByPressure(chatIds: number[], topN: number): Promise<PressureScore[]> {
  const scored = await Promise.all(
    chatIds.map((c) => calculatePressure(c).catch(() => ({ chatId: c, pressure: 0, volume: 0, intimacy: 1, hunger: 1, ignoredPenalty: 1 } as PressureScore))),
  );
  scored.sort((a, b) => b.pressure - a.pressure);
  return scored.slice(0, topN);
}

/** bot 瞄了这个群但没开口 → ignored++(下次 pressure 降一点)。 */
export async function markOffered(chatId: number): Promise<void> {
  try {
    const redis = getRedis();
    await redis.incr(IGNORED_PREFIX + chatId);
    await redis.expire(IGNORED_PREFIX + chatId, IGNORED_TTL_SEC);
  } catch { /* non-critical */ }
}

/** bot 真的在这个群开口了 → 清零 ignored。 */
export async function markActioned(chatId: number): Promise<void> {
  try {
    await getRedis().del(IGNORED_PREFIX + chatId);
  } catch { /* non-critical */ }
}
