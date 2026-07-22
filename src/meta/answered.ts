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
    await getRedis().set(key(chatId, mid), '1', 'EX', TTL_SEC);
  } catch (err) {
    logger.debug({ err, chatId, messageId: mid }, 'markMessageAnswered failed');
  }
}

export async function isMessageAnswered(chatId: number, messageId: number): Promise<boolean> {
  const mid = Math.floor(Number(messageId));
  if (!Number.isFinite(chatId) || !Number.isFinite(mid) || mid <= 0) return false;
  try {
    return (await getRedis().get(key(chatId, mid))) === '1';
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
