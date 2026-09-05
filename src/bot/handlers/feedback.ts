// ────────────────────────────────────────
// Feedback Handler — reaction + reply hooks (AGI Level 4 P3)
// ────────────────────────────────────────

import type { Context } from 'grammy';
import { getBotUid } from '../../bot/bot.js';
import { getBot } from '../../bot/bot.js';
import { recordReaction, recordReplySentiment } from '../../tracking/feedback.js';
import { logger } from '../../shared/logger.js';

const EMOJI_SENTIMENT: Record<string, number> = {
  '👍': 0.6, '❤': 0.9, '🔥': 0.8, '😂': 0.7, '😍': 0.9, '🎉': 0.8,
  '👏': 0.7, '💯': 0.8, '🙏': 0.5, '😮': 0.3, '👀': 0.1,
  '👎': -0.6, '💩': -0.7, '😡': -0.9, '🤮': -0.9, '😢': -0.5,
  '🖕': -0.9, '😠': -0.7, '🤨': -0.3, '😒': -0.4,
};

export function registerFeedbackHandler(): void {
  const botUid = getBotUid();
  if (!botUid) return;

  // Reaction updates — 用户给 bot 消息点 emoji
  getBot().on('message_reaction', (ctx: Context) => {
    try {
      const mr = ctx.messageReaction;
      if (!mr || !('user' in mr) || !('chat' in mr && 'id' in mr.chat)) return;
      const reaction = mr as {
        user: { id: number } | undefined;
        chat: { id: number };
        message_id: number;
        from?: { id?: number };
        new_reaction: Array<{ type: string }>;
      };
      if (!reaction.user) return;
      if (!('id' in (reaction.from ?? ({} as { id?: number })) && (reaction.from as { id?: number }).id === botUid)) return;

      const userId = reaction.user.id;
      const botMessageId = reaction.message_id;
      const chatId = reaction.chat.id;

      for (const r of reaction.new_reaction) {
        if (r.type !== 'emoji') continue;
        const rTyped = r as { emoji?: { emoji?: string }; custom_emoji_id?: string };
        if (rTyped.custom_emoji_id) continue; // skip custom emoji
        const emoji = rTyped.emoji?.emoji;
        if (emoji) {
          const s = EMOJI_SENTIMENT[emoji] ?? 0;
          if (s !== 0) recordReaction({ userId, botMessageId, chatId, emoji });
        }
      }
    } catch (err) {
      logger.debug({ err }, 'feedback reaction handler failed');
    }
  });

  // Reply messages — 用户回复了 bot 的消息，记录情绪
  getBot().on('message:text', (ctx: Context) => {
    try {
      const msg = ctx.message;
      if (!msg || !msg.reply_to_message) return;
      const replyFrom = msg.reply_to_message as { from?: { id?: number } };
      if (!('id' in (replyFrom.from ?? {})) || replyFrom.from!.id !== botUid) return;
      if (!msg.from) return;

      const userId = msg.from.id;
      const botMessageId = msg.reply_to_message.message_id;
      const text = (msg.text ?? '').trim();
      if (text.length < 2) return;

      recordReplySentiment({ userId, botMessageId, chatId: msg.chat.id, userText: text });
    } catch {
      // non-critical, silent
    }
  });
}
