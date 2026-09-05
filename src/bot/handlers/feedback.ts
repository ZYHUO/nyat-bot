// ────────────────────────────────────────
// Feedback Handler — reaction + reply hooks (AGI Level 4 P3)
//
// reaction → recordReaction(写 feedback_events) → bandit reward 回流；
// reply-to-bot → recordReplySentiment(含 quote 追问强正)。
// 归因口径统一走 recordReward（reaction/reply 共用）：live topics 均分。
// ────────────────────────────────────────

import type { Context } from 'grammy';
import type { ReactionType } from '@grammyjs/types';
import { getBotUid } from '../../bot/bot.js';
import { getBot } from '../../bot/bot.js';
import { recordReaction, recordReplySentiment } from '../../tracking/feedback.js';
import { getRecent } from '../../pipeline/context/manager.js';
import { logger } from '../../shared/logger.js';

const EMOJI_SENTIMENT: Record<string, number> = {
  '👍': 0.6, '❤': 0.9, '🔥': 0.8, '😂': 0.7, '😍': 0.9, '🎉': 0.8,
  '👏': 0.7, '💯': 0.8, '🙏': 0.5, '😮': 0.3, '👀': 0.1,
  '👎': -0.6, '💩': -0.7, '😡': -0.9, '🤮': -0.9, '😢': -0.5,
  '🖕': -0.9, '😠': -0.7, '🤨': -0.3, '😒': -0.4,
};

/**
 * 该 messageId 是不是 bot 自己发过的（查 Redis ctx 近窗）。
 * TG 的 message_reaction update 没有 from 字段——旧代码用 reaction.from
 * 判"bot 发出的 reaction"永远走不通，这就是 feedback_events 长期 0 行的根因。
 */
async function isOwnMessage(chatId: number, messageId: number): Promise<boolean> {
  try {
    const recent = await getRecent(chatId, 100);
    const botUid = getBotUid();
    return recent.some(
      (m) => m.messageId === messageId && (m.role === 'assistant' || (botUid > 0 && m.uid === botUid)),
    );
  } catch {
    return false;
  }
}

export function registerFeedbackHandler(): void {
  const botUid = getBotUid();
  if (!botUid) return;

  // Reaction updates — 用户给 bot 消息点 emoji
  getBot().on('message_reaction', (ctx: Context) => {
    void (async () => {
      try {
        const mr = ctx.messageReaction;
        if (!mr) return;
        const chatId = mr.chat.id;
        if (chatId >= 0) return; // 只收群聊
        const reactor = mr.user;
        if (!reactor) return; // 匿名 reaction 无 user，跳过
        if (reactor.id === botUid) return; // 自己点的不算
        const botMessageId = mr.message_id;
        if (!(await isOwnMessage(chatId, botMessageId))) return;

        const news: ReactionType[] = mr.new_reaction ?? [];
        const olds: ReactionType[] = mr.old_reaction ?? [];
        const oldEmojis = new Set(
          olds.filter((r) => r.type === 'emoji').map((r) => (r as { emoji: string }).emoji),
        );
        for (const r of news) {
          if (r.type !== 'emoji') continue; // custom_emoji / paid 跳过
          const emoji = (r as { emoji?: string }).emoji;
          if (!emoji || oldEmojis.has(emoji)) continue; // 取消后重加才算，重复推送去重
          const s = EMOJI_SENTIMENT[emoji] ?? 0;
          if (s !== 0) recordReaction({ userId: reactor.id, botMessageId, chatId, emoji });
        }
      } catch (err) {
        logger.debug({ err }, 'feedback reaction handler failed');
      }
    })();
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
