// ────────────────────────────────────────
// Memory "dream" cron — nightly forgetting / consolidation.
//
// Keeps the Chroma memory lean: forgets old memories that were never recalled
// into a reply (they're noise), while preserving anything recent or ever-used.
// Ported from LeoYeAI/openclaw-auto-dream's forgetting curve.
// ────────────────────────────────────────

import { deleteMemories } from '../memory/chroma.js';
import { chatsWithMemory, getForgettableIds, deleteMeta } from '../memory/importance.js';
import { logger } from '../shared/logger.js';

const FORGET_MIN_AGE_DAYS = 30;   // tunable — only forget memories older than this
const FORGET_MAX_PER_CHAT = 500;  // tunable — cap deletions per chat per run

const log = logger.child({ mod: 'memory-dream' });

/** Run a forgetting pass over all chats. Returns total memories forgotten. */
export async function runMemoryDream(): Promise<number> {
  const chats = chatsWithMemory();
  let total = 0;
  for (const chatId of chats) {
    try {
      const ids = getForgettableIds(chatId, FORGET_MIN_AGE_DAYS, FORGET_MAX_PER_CHAT);
      if (ids.length === 0) continue;
      const deleted = await deleteMemories(ids);
      if (deleted > 0) {
        deleteMeta(ids); // only drop sidecar rows we actually pruned from Chroma
        total += deleted;
        log.info({ chatId, forgotten: deleted }, 'Memory dream: forgot stale memories');
      }
    } catch (err) {
      log.debug({ err, chatId }, 'Memory dream: chat failed');
    }
  }
  return total;
}
