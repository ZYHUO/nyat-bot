// ────────────────────────────────────────
// Curiosity — 好奇心延续(L5):问出去的问题会被惦记
// ────────────────────────────────────────
//
// 纯被动是最深的 bot 信号:真群友问了你一句没得到回答,下次见到你会
// 追问。这里把 bot 自己发出的问句记成"惦记"(per chat+uid,48h TTL);
// 那个人再次出现时,若问题悬了 30 分钟以上,提示写手可以追一句。
//
// 两段式消费(review #7):prompt 拼装时只 PEEK(不删),真正发出回复后
// 才 COMMIT 删除 —— 否则生成被打断/迟到抑制/静默时,惦记被白白吞掉。

import { getRedis } from '../db/redis.js';

const KEY = (chatId: number, uid: number) => `xxb:curio:${chatId}:${uid}`;
const TTL_SEC = 48 * 3600;
/** 问题悬置多久才值得追(太快追显得逼问) */
const MIN_AGE_SEC = 30 * 60;

/** bot 的回复以问句收尾 → 记一笔惦记(全角?是中文回复的常态,review #1) */
export async function noteAskedQuestion(chatId: number, targetUid: number, replyText: string): Promise<void> {
  const text = (replyText || '').trim();
  if (!/[?？]\s*$/.test(text) || text.length < 6) return;
  try {
    const k = KEY(chatId, targetUid);
    // multi:写入与 TTL 原子化,绝不留下永不过期的孤儿 key(review #15)
    await getRedis().multi()
      .hset(k, 'q', text.slice(0, 80), 'ts', String(Math.floor(Date.now() / 1000)))
      .expire(k, TTL_SEC)
      .exec();
  } catch { /* non-critical */ }
}

/** 那个人出现了:读悬置足够久的问题(只读不删,发送成功后才 commit) */
export async function peekPendingQuestion(chatId: number, uid: number): Promise<string | null> {
  try {
    const raw = await getRedis().hgetall(KEY(chatId, uid));
    if (!raw['q'] || !raw['ts']) return null;
    const age = Math.floor(Date.now() / 1000) - Number(raw['ts']);
    if (age < MIN_AGE_SEC) return null;
    return raw['q'];
  } catch {
    return null;
  }
}

/**
 * 回复确认发出后核销惦记(只追一次)。重做 peek 的悬置检查再删 ——
 * 没到 30 分钟的问题不会被注入,也就不该被这次发送顺手抹掉。
 */
export async function commitPendingQuestion(chatId: number, uid: number): Promise<void> {
  try {
    const redis = getRedis();
    const k = KEY(chatId, uid);
    const raw = await redis.hgetall(k);
    if (!raw['q'] || !raw['ts']) return;
    const age = Math.floor(Date.now() / 1000) - Number(raw['ts']);
    if (age >= MIN_AGE_SEC) await redis.del(k);
  } catch { /* non-critical */ }
}
