// ────────────────────────────────────────
// 消息去重中间件 (Redis SET + TTL)
// ────────────────────────────────────────

import { getRedis } from '../../db/redis.js';
import { logger } from '../../shared/logger.js';

const DEDUP_PREFIX = 'xxb:dedup:';
/** 24h — 重启后 Telegram 偶发重放 / offset 漂移时仍能挡住老 message_id */
const DEDUP_TTL = 86_400;

/**
 * @param editDate 编辑事件的 `msg.edit_date`。**必须传** —— 只用 ':edit' 后缀的话,
 *   同一条消息的第二次及以后的编辑会命中第一次编辑写下的 key(TTL 24h)而被静默丢弃,
 *   实际效果是"每条消息只允许改一次"。而项目其它地方明确是要处理编辑的
 *   (formatter 用 `edit_date ?? date` 记时间戳,message handler 有
 *   `noReschedule: isEdit && !isDirect`,还有 editByContentOnly 的直接互动检测)。
 */
export async function isDuplicate(
  chatId: number,
  messageId: number,
  isEdit = false,
  editDate?: number,
): Promise<boolean> {
  const redis = getRedis();
  // Include event type + edit generation in key so each edit is processed once.
  const suffix = isEdit ? `:edit:${editDate ?? 0}` : '';
  const key = `${DEDUP_PREFIX}${chatId}:${messageId}${suffix}`;

  // SET NX returns 'OK' if key was set (new), null if key already exists
  const result = await redis.set(key, '1', 'EX', DEDUP_TTL, 'NX');

  if (result === null) {
    logger.debug({ chatId, messageId, isEdit }, 'Duplicate message skipped');
    return true;
  }

  return false;
}
