// ─────────────────────────────────────────────────────────────────────────────
// 入群账号信号（join account signals）
// ─────────────────────────────────────────────────────────────────────────────
//
// 2026-09-20 用户给出的真实判据（比名字关键词好得多，因为它们是**账号属性**）：
//
//   "既没头像、名字还像乱写的、注册时间比较新的，就是 ad 人"
//
// 三个信号里 Telegram Bot API 能直接拿到两个：
//
//   没头像   getUserProfilePhotos(uid).total_count === 0        ✓ 可查
//   名字乱写 作为**事实**呈现，不作为判定（见 nameShapeNote）     ✓ 可算
//   注册新   Bot API 不暴露账号注册时间                          ✗
//
// 对第三个，用"我们第一次见到这个 uid"代替：一个刚注册的黑产号进群时，
// 我们不可能见过它。这不是同一个事实，但是同方向的一个代理 —— 注释里写明区别。
//
// 与反广告同一条立场：**宿主只报事实，模型决定踢不踢。**
// 这里没有任何"三者齐备就踢"的规则 —— 那正是用户说不要的东西。

import { getRedis } from '../db/redis.js';
import { logger } from '../shared/logger.js';

export interface JoinSignals {
  uid: number;
  /** 有没有头像（getUserProfilePhotos 的 total_count > 0）。查失败为 null（未知）。 */
  hasPhoto: boolean | null;
  /** 我们第一次见到这个 uid 的 unix 秒；0 = 从未记录过（本次就是首次）。 */
  firstSeenAt: number;
  /** 距首次见到过了多久（秒）。 */
  knownForSec: number;
  /** 对名字形态的**事实描述**，不是判定。例："12 位随机字母数字、无空格"。 */
  nameShapeNote: string;
}

const FIRST_SEEN_KEY = (uid: number): string => `xxb:join:firstseen:${uid}`;

/**
 * 记录/读取"首次见到该 uid"。TTL 90 天——够覆盖"新号"的判定窗口，
 * 又不至于让键无限增长。已存在则**不改写**（首次才是首次）。
 */
export async function noteFirstSeen(uid: number, now = Math.floor(Date.now() / 1000)): Promise<number> {
  try {
    const r = getRedis();
    const k = FIRST_SEEN_KEY(uid);
    const existing = await r.get(k);
    if (existing) return Number(existing);
    await r.set(k, String(now), 'EX', 90 * 86400);
    return now;
  } catch (err) {
    logger.debug({ err, uid }, 'noteFirstSeen failed (non-critical)');
    return now;
  }
}

/**
 * 名字形态的**事实描述**。刻意不给"像不像乱写"的结论 —— 那是模型的活。
 * 只报可核对的属性：长度、字符类、有无空格、是否含常见词。
 */
export function nameShapeNote(name: string): string {
  const t = String(name ?? '').trim();
  if (!t) return '空名字';
  const hasSpace = /\s/.test(t);
  const hasCJK = /[\u4e00-\u9fff]/.test(t);
  const alnumOnly = /^[A-Za-z0-9_.-]+$/.test(t);
  const bits: string[] = [`${t.length} 字符`];
  if (hasCJK) bits.push('含中文');
  if (hasSpace) bits.push('有空格');
  if (alnumOnly && !hasSpace) bits.push('纯字母数字无空格');
  if (/\d/.test(t) && alnumOnly && t.length >= 8) bits.push('长串字母数字混合');
  return bits.join('，');
}

/** 查头像。Telegram Bot API：getUserProfilePhotos。失败返回 null（未知，不猜）。 */
export async function checkHasPhoto(bot: { api: { getUserProfilePhotos: (u: number, o?: unknown) => Promise<{ total_count: number }> } }, uid: number): Promise<boolean | null> {
  try {
    const r = await bot.api.getUserProfilePhotos(uid, { limit: 1 });
    return r.total_count > 0;
  } catch (err) {
    logger.debug({ err, uid }, 'checkHasPhoto failed (non-critical)');
    return null; // 读失败按未知处理——不要因为查不到就当成"没有"
  }
}

/** 采集一个入群者的三个信号。 */
export async function readJoinSignals(
  bot: { api: { getUserProfilePhotos: (u: number, o?: unknown) => Promise<{ total_count: number }> } },
  uid: number,
  displayName: string,
  now = Math.floor(Date.now() / 1000),
): Promise<JoinSignals> {
  const [hasPhoto, firstSeenAt] = await Promise.all([
    checkHasPhoto(bot, uid),
    noteFirstSeen(uid, now),
  ]);
  return {
    uid,
    hasPhoto,
    firstSeenAt,
    knownForSec: Math.max(0, now - firstSeenAt),
    nameShapeNote: nameShapeNote(displayName),
  };
}

/** Frame 呈现：三件事实，不给裁决。 */
export function renderJoinSignals(s: JoinSignals, name: string): string {
  const photo = s.hasPhoto === null ? '头像未知（查不到）' : s.hasPhoto ? '有头像' : '**没有头像**';
  const known = s.knownForSec < 3600
    ? `我们第一次见到它（${s.knownForSec} 秒前）`
    : `我们已认识它 ${Math.floor(s.knownForSec / 3600)} 小时`;
  return `[入群] ${name}：${photo}｜名字：${s.nameShapeNote}｜${known}。是不是黑产广告号，你判；机场/代理那类不用管。`;
}
