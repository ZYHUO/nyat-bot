// ────────────────────────────────────────
// 口头禅自动检测 + 惩罚闭环(和 reinforceExpressions 奖励side 对称的惩罚side)
// ────────────────────────────────────────
//
// 手动打地鼠的问题:每复发一个口头禅(是吧→我勒个→…)都要人肉加进
// isBannedExpression。这里让系统自己抓自己罚:
//   1. 检测:盯 bot 最近发言,**句首 / 句尾** 的短语复读超阈值 → 判为新生口头禅。
//      (口头禅几乎都活在句首「我勒个X」或句尾「…是吧」,只扫这两处,噪音远小于全 n-gram。)
//   2. 惩罚:① DB 里含该短语的已学表达 count→1(停止在注入池里霸榜,inverse of reinforce)
//           ② 写进带 TTL 的 Redis 动态黑名单 → 注入侧不再喂回 + prompt 提示"少说"。
//   3. 自愈:黑名单 TTL 到期即解禁;下轮若还超阈值则续期,不超则自然消退。
//
// 只做"软"惩罚(降权 + 不注入 + 提示),**不**在输出里硬删任意短语(会切坏句子);
// 「喵」的输出级稀释另由 segmenter 的 thinMeowTic 负责。

import { getRedis } from '../db/redis.js';
import { getDb } from '../db/sqlite.js';
import { logger } from '../shared/logger.js';

export interface TicHit {
  /** 归一后的口头禅短语 */
  phrase: string;
  /** 出现在多少条不同消息里 */
  messages: number;
  /** 占采样窗口的比例 */
  fraction: number;
  /** 句首还是句尾 */
  pos: 'head' | 'tail';
}

export interface DetectOptions {
  /** 至少出现在这么多条消息里才算(默认 4) */
  minMessages: number;
  /** 至少占窗口这个比例(默认 0.35) */
  minFraction: number;
}

const TAIL_TRIM = /[\s~～。.!！?？,，、…·「」"'`''()（）]+$/u;
const HEAD_TRIM = /^[\s~～。.!！?？,，、…·「」"'`''()（）]+/u;
// 归一时剥掉句尾猫腔(喵由 thinMeow 管,别让每条都被判成「喵」口癖)
const MEOW_TAIL = /(喵+呜?)([~～]*)$/u;

/** 一条消息里,句首/句尾各取 2-4 字的候选短语(已归一)。 */
function candidatesOf(text: string): { head: string[]; tail: string[] } {
  let s = (text ?? '').trim();
  if (!s) return { head: [], tail: [] };
  // 多行只看第一行开头 + 最后一行结尾
  const head0 = s.split(/\n/)[0]!.replace(HEAD_TRIM, '');
  let tail0 = s.split(/\n/).pop()!.replace(TAIL_TRIM, '').replace(MEOW_TAIL, '').replace(TAIL_TRIM, '');
  const heads: string[] = [];
  const tails: string[] = [];
  const hchars = [...head0];
  const tchars = [...tail0];
  for (const n of [4, 3, 2]) {
    if (hchars.length >= n) heads.push(hchars.slice(0, n).join(''));
    if (tchars.length >= n) tails.push(tchars.slice(-n).join(''));
  }
  return { head: heads, tail: tails };
}

/** 该候选是否值得判罚(排除纯标点/纯表情/纯猫腔/单字重复)。 */
function isMeaningful(p: string): boolean {
  if (!p || [...p].length < 2) return false;
  if (/^喵+呜?$/.test(p)) return false;
  // 至少含一个中文字或字母数字(排除纯符号/表情)
  return /[一-鿿a-zA-Z0-9]/.test(p);
}

/**
 * 从最近发言里检测新生口头禅(纯函数,可单测)。
 * 句首、句尾分别统计"出现在多少条不同消息里",超阈值即命中;去重时保留更长(更具体)的。
 */
export function detectEmergentTics(texts: string[], opts: DetectOptions): TicHit[] {
  const total = texts.length;
  if (total === 0) return [];
  const headCount = new Map<string, number>();
  const tailCount = new Map<string, number>();
  for (const t of texts) {
    const { head, tail } = candidatesOf(t);
    // 同一条消息内去重(一条只给一个候选计一次)
    for (const h of new Set(head)) if (isMeaningful(h)) headCount.set(h, (headCount.get(h) ?? 0) + 1);
    for (const t2 of new Set(tail)) if (isMeaningful(t2)) tailCount.set(t2, (tailCount.get(t2) ?? 0) + 1);
  }
  const collect = (m: Map<string, number>, pos: 'head' | 'tail'): TicHit[] => {
    const hits: TicHit[] = [];
    for (const [phrase, messages] of m) {
      const fraction = messages / total;
      if (messages >= opts.minMessages && fraction >= opts.minFraction) {
        hits.push({ phrase, messages, fraction, pos });
      }
    }
    // 去重:同 pos 下,若短候选被更长候选包含且计数接近,丢短的(保留更具体的「我勒个」而非「我勒」)
    hits.sort((a, b) => [...b.phrase].length - [...a.phrase].length);
    const kept: TicHit[] = [];
    for (const h of hits) {
      const dup = kept.find((k) => k.phrase.includes(h.phrase) && k.messages >= h.messages - 1);
      if (!dup) kept.push(h);
    }
    return kept;
  };
  return [...collect(headCount, 'head'), ...collect(tailCount, 'tail')].sort((a, b) => b.messages - a.messages);
}

// ─── Redis 动态黑名单(ZSET member=短语, score=到期时间戳) ───

function banKey(chatId: number): string {
  return `xxb:tic:ban:${chatId}`;
}

/** 读某群当前生效的口头禅黑名单(顺手剪掉过期项)。 */
export async function getDynamicTicBans(chatId: number): Promise<string[]> {
  try {
    const redis = getRedis();
    const now = Math.floor(Date.now() / 1000);
    await redis.zremrangebyscore(banKey(chatId), 0, now).catch(() => {});
    return await redis.zrangebyscore(banKey(chatId), now, '+inf');
  } catch (err) {
    logger.debug({ err, chatId }, 'getDynamicTicBans failed (non-critical)');
    return [];
  }
}

/** 把命中的口头禅写进带 TTL 的动态黑名单(续期式)。 */
export async function addDynamicTicBans(chatId: number, phrases: string[], ttlSec: number): Promise<void> {
  if (phrases.length === 0) return;
  try {
    const redis = getRedis();
    const expiry = Math.floor(Date.now() / 1000) + ttlSec;
    const args: (string | number)[] = [];
    for (const p of phrases) args.push(expiry, p);
    await redis.zadd(banKey(chatId), ...args);
    await redis.expire(banKey(chatId), ttlSec + 60); // 整个 key 兜底过期
  } catch (err) {
    logger.debug({ err, chatId }, 'addDynamicTicBans failed (non-critical)');
  }
}

/** DB 惩罚:含该短语的已学表达 count 打回 1(停止霸占注入池)。返回受影响行数。 */
export function demoteExpressions(chatId: number, phrases: string[]): number {
  if (phrases.length === 0) return 0;
  try {
    const db = getDb();
    const stmt = db.prepare(
      "UPDATE expressions SET count = 1, updated_at = ? WHERE chat_id = ? AND count > 1 AND style LIKE ?",
    );
    const now = Math.floor(Date.now() / 1000);
    let changed = 0;
    for (const p of phrases) changed += stmt.run(now, chatId, `%${p}%`).changes;
    return changed;
  } catch (err) {
    logger.debug({ err, chatId }, 'demoteExpressions failed (non-critical)');
    return 0;
  }
}
