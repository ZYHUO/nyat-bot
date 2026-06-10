// ────────────────────────────────────────
// Mind — 每群持续内心状态(L2:MaiBot _last_reasoning_content 对标)
// ────────────────────────────────────────
//
// 此前每条消息都是失忆重启:自我状态从零拼装,上一个念头被丢掉。
// 这里维护 xxb:turn:mind:{chatId}(20min TTL):
//   lastThought — 心流最近一次内心独白(reply/pass 都记:沉默也是念头)
//   stance     — 自己最近一次发言的落点(立场延续)
// composeSelfState 读它 → 判断与写作都带着"刚才在想什么"。

import { getRedis } from '../../db/redis.js';

const MIND_KEY = (chatId: number) => `xxb:turn:mind:${chatId}`;
const TTL_SEC = 20 * 60;

export interface Mind {
  lastThought?: string;
  stance?: string;
}

export async function getMind(chatId: number): Promise<Mind> {
  try {
    const raw = await getRedis().hgetall(MIND_KEY(chatId));
    return {
      lastThought: raw['lastThought'] || undefined,
      stance: raw['stance'] || undefined,
    };
  } catch {
    return {};
  }
}

/** 心流每次决策后记录念头(fire-and-forget;multi 保证写入与 TTL 原子) */
export async function noteThought(chatId: number, thought: string): Promise<void> {
  if (!thought) return;
  try {
    await getRedis().multi()
      .hset(MIND_KEY(chatId), 'lastThought', thought.slice(0, 60))
      .expire(MIND_KEY(chatId), TTL_SEC)
      .exec();
  } catch { /* non-critical */ }
}

/** 发言后记录落点(自己最近说了什么立场) */
export async function noteStance(chatId: number, replyText: string): Promise<void> {
  if (!replyText) return;
  try {
    await getRedis().multi()
      .hset(MIND_KEY(chatId), 'stance', replyText.slice(0, 60))
      .expire(MIND_KEY(chatId), TTL_SEC)
      .exec();
  } catch { /* non-critical */ }
}
