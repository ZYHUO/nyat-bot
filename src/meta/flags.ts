import { env } from '../env.js';

/** Whether this chat should use Meta+Subagent path (not legacy enqueue). */
export function isMetaSubagentChat(chatId: number): boolean {
  const e = env();
  if (!e.META_SUBAGENT_ENABLED) return false;
  const list = e.META_SUBAGENT_CHAT_IDS;
  if (list.length === 0) return true;
  return list.includes(chatId);
}
