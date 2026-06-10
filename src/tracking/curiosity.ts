// ────────────────────────────────────────
// Curiosity — 好奇心延续(L5):问出去的问题会被惦记
// ────────────────────────────────────────
//
// 纯被动是最深的 bot 信号:真群友问了你一句没得到回答,下次见到你会
// 追问。这里把 bot 自己发出的问句记成"惦记"(per chat+uid,48h TTL);
// 那个人再次出现时,若问题悬了 30 分钟以上,提示写手可以追一句。
// 注入即清除 —— 追问一次就够,不变成夺命连环 call。

import { getRedis } from '../db/redis.js';

const KEY = (chatId: number, uid: number) => `xxb:curio:${chatId}:${uid}`;
const TTL_SEC = 48 * 3600;
/** 问题悬置多久才值得追(太快追显得逼问) */
const MIN_AGE_SEC = 30 * 60;

/** bot 的回复以问句收尾 → 记一笔惦记 */
export async function noteAskedQuestion(chatId: number, targetUid: number, replyText: string): Promise<void> {
  const text = (replyText || '').trim();
  if (!/[??]\s*$/.test(text) || text.length < 6) return;
  try {
    const redis = getRedis();
    await redis.hset(KEY(chatId, targetUid), 'q', text.slice(0, 80), 'ts', String(Math.floor(Date.now() / 1000)));
    await redis.expire(KEY(chatId, targetUid), TTL_SEC);
  } catch { /* non-critical */ }
}

/** 那个人出现了:取出悬置足够久的问题(取即清,只追一次) */
export async function takePendingQuestion(chatId: number, uid: number): Promise<string | null> {
  try {
    const redis = getRedis();
    const raw = await redis.hgetall(KEY(chatId, uid));
    if (!raw['q'] || !raw['ts']) return null;
    const age = Math.floor(Date.now() / 1000) - Number(raw['ts']);
    if (age < MIN_AGE_SEC) return null;
    await redis.del(KEY(chatId, uid));
    return raw['q'];
  } catch {
    return null;
  }
}
