// ────────────────────────────────────────
// Turn Actor — flag helpers(独立小模块,避免 actor ↔ chat-runtime 循环依赖)
// ────────────────────────────────────────

import { env } from '../../env.js';

/** Is this chat routed through the turn actor (graylist-aware)? */
export function isTurnActorChat(chatId: number): boolean {
  const e = env();
  if (!e.TURN_ACTOR_ENABLED) return false;
  const graylist = e.TURN_ACTOR_CHAT_IDS;
  return graylist.length === 0 || graylist.includes(chatId);
}
