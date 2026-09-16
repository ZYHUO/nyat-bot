// ────────────────────────────────────────
// BOT_KNOWLEDGE tool — local (no HTTP)
// Port of PHP BotInteractionTracker::handleToolQuery()
// ────────────────────────────────────────

import { getBotTracker } from '../../tracking/interaction.js';

export async function queryBotKnowledge(chatId: number, query: string): Promise<string> {
  const tracker = getBotTracker();
  if (!tracker) return 'Bot 知识系统未启用。';
  return tracker.handleToolQuery(chatId, query);
}
