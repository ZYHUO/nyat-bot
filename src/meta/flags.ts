import { env } from '../env.js';
import { isPlatformInternalId } from '../platform/identity-store.js';
import { heartRoute } from './heart-route.js';

/** Whether this chat should use Meta+Subagent path (not legacy enqueue). */
export function isMetaSubagentChat(chatId: number): boolean {
  const e = env();
  if (!e.META_SUBAGENT_ENABLED) return false;
  const list = e.META_SUBAGENT_CHAT_IDS;
  if (list.length === 0) return true;
  return list.includes(chatId);
}

/** Pending-intent revisions also fence a released decision in Attention and at the sender. */
export function isTelegramHeartBatchChat(chatId: number): boolean {
  const e = env();
  return e.META_TG_GROUP_COALESCE_MS > 0 && e.META_TG_GROUP_COALESCE_CHAT_IDS.includes(chatId)
    && chatId < 0 && !isPlatformInternalId(chatId) && e.META_PENDING_INTENT_ENABLED
    && isMetaSubagentChat(chatId) && heartRoute(e, chatId) === 'heart';
}
