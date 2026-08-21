// ────────────────────────────────────────
// 「想起再回」——当时没接的话头（真人感：真人看到了没回，过阵子想起来还能捡回来）
// ────────────────────────────────────────
//
// heart 判 pass 时，若消息其实冲着 bot 来（@/回复 bot/叫名字），记一笔到
// Redis list。unified-tick 决策时 peek 到就可能在群冷场时自然捡起来回一句。
// 群被选中发言后 clear——「想起」是一次性的，别反复纠结。TTL 3h 兜底自然过期。

import { getRedis } from '../db/redis.js';
import { logger } from '../shared/logger.js';

const CAP = 5;
const TTL_SEC = 3 * 3600;

export interface MissedItem {
  messageId: number;
  uid: number;
  name: string;
  text: string;
  ts: number;
  /** message=冲 bot 来没接的话头；join=新人进群（真人环境：可以自然欢迎）。 */
  kind?: 'message' | 'join';
}

function key(chatId: number): string {
  return `xxb:missed:${chatId}`;
}

export async function noteMissed(
  chatId: number,
  item: Omit<MissedItem, 'ts'>,
): Promise<void> {
  try {
    const redis = getRedis();
    const entry = JSON.stringify({ ...item, ts: Math.floor(Date.now() / 1000) });
    await redis.lpush(key(chatId), entry);
    await redis.ltrim(key(chatId), 0, CAP - 1);
    await redis.expire(key(chatId), TTL_SEC);
  } catch (err) {
    logger.debug({ err, chatId }, 'noteMissed failed');
  }
}

/** 看一眼不删——tick 展示用；群被选中发言后由 clearMissed 收尾。 */
export async function peekMissed(chatId: number): Promise<MissedItem[]> {
  try {
    const raw = await getRedis().lrange(key(chatId), 0, CAP - 1);
    const out: MissedItem[] = [];
    for (const r of raw) {
      try {
        out.push(JSON.parse(r) as MissedItem);
      } catch {
        /* skip malformed */
      }
    }
    return out;
  } catch (err) {
    logger.debug({ err, chatId }, 'peekMissed failed');
    return [];
  }
}

export async function clearMissed(chatId: number): Promise<void> {
  try {
    await getRedis().del(key(chatId));
  } catch (err) {
    logger.debug({ err, chatId }, 'clearMissed failed');
  }
}
