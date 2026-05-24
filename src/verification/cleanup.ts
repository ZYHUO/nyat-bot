import type { Bot } from 'grammy';
import { logger } from '../shared/logger.js';
import { getDb } from '../db/sqlite.js';
import { getRedis } from '../db/redis.js';
import * as store from './store.js';

/**
 * Check for timed-out verification records and clean them up.
 * Should be called periodically (e.g., every 60 seconds).
 */
export async function cleanupTimedOutVerifications(bot: Bot): Promise<void> {
  const db = getDb();
  const redis = getRedis();

  const timedOut = store.getTimedOutRecords(db);
  if (timedOut.length === 0) return;

  logger.info({ count: timedOut.length }, 'Cleaning up timed-out verifications');

  for (const record of timedOut) {
    try {
      // Mark as timeout
      store.updateRecordStatus(db, record.id, 'timeout');

      // Kick user from group
      try {
        await bot.api.banChatMember(record.chat_id, record.user_id);
        await bot.api.unbanChatMember(record.chat_id, record.user_id);
        store.updateRecordStatus(db, record.id, 'kicked');
      } catch (err) {
        logger.warn({ err, chatId: record.chat_id, userId: record.user_id }, 'Failed to kick timed-out user');
      }

      // Delete Redis key
      await redis.del(`xxb:verify:active:${record.user_id}`);

      // Edit DM message if possible
      if (record.dm_message_id) {
        try {
          await bot.api.editMessageText(
            record.user_id,
            record.dm_message_id,
            '⏰ 验证已超时，你已被移出群组。可以重新加入再次验证。',
          );
        } catch { /* ignore */ }
      }

      // Notify in group
      try {
        const name = record.first_name ?? '用户';
        await bot.api.sendMessage(
          record.chat_id,
          `⏰ ${name} 的入群验证已超时，已被移出群组。`,
        );
      } catch { /* ignore */ }

      logger.info({ chatId: record.chat_id, userId: record.user_id, recordId: record.id }, 'Verification timed out');
    } catch (err) {
      logger.error({ err, recordId: record.id }, 'Failed to cleanup timed-out verification');
    }
  }
}
