import { getRedis } from '../db/redis.js';
import { logger } from '../shared/logger.js';

/** 7 天 — 重启后 Attention 残留 / busy requeue 不能再回同一条 */
const TTL_SEC = 7 * 24 * 3600;

function key(chatId: number, messageId: number): string {
  return `xxb:meta:answered:${chatId}:${messageId}`;
}

/** Mark a user message as already replied-to (anti double-reply). */
export async function markMessageAnswered(chatId: number, messageId: number): Promise<void> {
  const mid = Math.floor(Number(messageId));
  if (!Number.isFinite(chatId) || !Number.isFinite(mid) || mid <= 0) return;
  try {
    // round 4：累加成时间戳列表（留最近 5 次），心流要拿它说"你已经回过 N 次"。
    // 旧的 '1' 会被覆盖成当前时间——语义等价（回到过去了），不丢信息。
    const prev = await getRedis().get(key(chatId, mid));
    const times = prev && prev !== '1'
      ? prev.split(',').map((x) => Number.parseInt(x, 10)).filter((n) => Number.isFinite(n) && n > 0)
      : [];
    times.push(Math.floor(Date.now() / 1000));
    await getRedis().set(key(chatId, mid), times.slice(-5).join(','), 'EX', TTL_SEC);
  } catch (err) {
    logger.debug({ err, chatId, messageId: mid }, 'markMessageAnswered failed');
  }
}

/**
 * 这条消息被本喵回过几次、都是什么时候（新的在前）。
 *
 * round 4（新 goal，用户："重复回复的概率太高了"）加的。
 *
 * `markMessageAnswered` 原来只写一个 `'1'`——够 attention 的"入没入过队"用,
 * 但心流需要知道的是"**我回过几次、上次是什么时候、上次说了什么**"。
 * 一个布尔值回答不了"你已经回过三次了",而后者才是能拦住复读的那个事实。
 *
 * 存的还是同一个 key,值从 '1' 改成逗号分隔的 unix 秒（最多留 5 条,再老的就
 * 只在 `isMessageAnswered` 里当"回过了"用）。读的时候兼容旧的 '1'——
 * 老 key 会被解释成"回过了但不知道什么时候",比读失败好。
 */
export async function answeredTimestamps(chatId: number, messageId: number): Promise<number[]> {
  const mid = Math.floor(Number(messageId));
  if (!Number.isFinite(chatId) || !Number.isFinite(mid) || mid <= 0) return [];
  try {
    const raw = await getRedis().get(key(chatId, mid));
    if (!raw) return [];
    if (raw === '1') return [];                      // 旧格式：只回过了，没时间
    const parsed = raw.split(',').map((x) => Number.parseInt(x, 10)).filter((n) => Number.isFinite(n) && n > 0);
    return parsed.sort((a, b) => b - a);
  } catch {
    return [];
  }
}

export async function isMessageAnswered(chatId: number, messageId: number): Promise<boolean> {
  const mid = Math.floor(Number(messageId));
  if (!Number.isFinite(chatId) || !Number.isFinite(mid) || mid <= 0) return false;
  try {
    // round 4：值的形状从 '1' 变成了逗号分隔的时间戳列表（见 markMessageAnswered）。
    // 这里必须跟着改——第一版改完了 writer 和新 reader、漏了这个老 reader,
    // 于是 `marks and detects answered quotes` 立刻红。
    // 判据放宽成"有值就算回过了"：'1'（旧格式）和时间戳列表都算。
    const raw = await getRedis().get(key(chatId, mid));
    return raw !== null && raw !== '' && raw !== '0';
  } catch {
    return false;
  }
}

/** True if every positive quote id was already answered. */
export async function allQuotesAnswered(chatId: number, quotes: number[]): Promise<boolean> {
  const ids = quotes.filter((n) => Number.isFinite(n) && n > 0);
  if (!ids.length) return false;
  for (const id of ids) {
    if (!(await isMessageAnswered(chatId, id))) return false;
  }
  return true;
}

/**
 * Batch check which messages are already answered — single MGET round-trip
 * instead of N serial GETs. Returns a Set of `"chatId:messageId"` strings
 * for messages that were already replied-to.
 */
export async function batchMessagesAnswered(
  entries: ReadonlyArray<{ chatId: number; messageId: number }>,
): Promise<Set<string>> {
  const valid = entries
    .map((e) => ({ chatId: e.chatId, mid: Math.floor(Number(e.messageId)) }))
    .filter((e) => Number.isFinite(e.chatId) && Number.isFinite(e.mid) && e.mid > 0);
  if (!valid.length) return new Set();
  const keys = valid.map((e) => key(e.chatId, e.mid));
  try {
    const vals = (await getRedis().mget(...keys)) as (string | null)[];
    const answered = new Set<string>();
    for (let i = 0; i < valid.length; i++) {
      const entry = valid[i];
      if (entry && vals[i] === '1') answered.add(`${entry.chatId}:${entry.mid}`);
    }
    return answered;
  } catch {
    return new Set();
  }
}
