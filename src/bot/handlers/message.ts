import type { Bot, Context } from 'grammy';
import { logger } from '../../shared/logger.js';
import { isDuplicate } from '../middleware/dedup.js';
import { isRateLimited } from '../middleware/rate-limit.js';
import { enqueue } from '../../queue/producer.js';
import { looksLikeDirectInteraction } from '../../pipeline/timing/direct-interaction.js';
import { isTurnActorChat } from '../../pipeline/turn/actor.js';
import { appendPending } from '../../pipeline/turn/buffer.js';
import { interruptGeneration } from '../../pipeline/turn/abort-registry.js';
import { bumpFocus } from '../../pipeline/turn/focus.js';
import { scheduleTurn } from '../../queue/turn-scheduler.js';
import { env } from '../../env.js';
import { getBotUid } from '../bot.js';

async function handleUpdate(ctx: Context): Promise<void> {
  const msg = ctx.message ?? ctx.editedMessage ?? ctx.channelPost ?? ctx.editedChannelPost;
  if (!msg) return;

  const chatId = msg.chat.id;
  const messageId = msg.message_id;
  const userId = msg.from?.id;
  const isEdit = !!(ctx.editedMessage ?? ctx.editedChannelPost);

  // Dedup (fail-open on Redis error to avoid silent message loss)
  try {
    if (await isDuplicate(chatId, messageId, isEdit)) return;
  } catch (err) {
    logger.warn({ err, chatId, messageId }, 'Dedup check failed, proceeding');
  }

  // Rate limit (fail-open on Redis error)
  try {
    if (userId && (await isRateLimited(userId))) return;
  } catch (err) {
    logger.warn({ err, userId }, 'Rate limit check failed, proceeding');
  }

  const senderChat = msg.sender_chat;
  const senderChatUsername = senderChat && 'username' in senderChat ? senderChat.username : undefined;
  const senderChatTitle = senderChat && 'title' in senderChat ? senderChat.title : undefined;
  const isAnonymousAdmin = msg.from?.id === 1087968824;
  const displayName = (isAnonymousAdmin || !msg.from)
    ? (senderChatTitle ?? senderChatUsername ?? 'channel')
    : (msg.from.username ?? msg.from.first_name ?? 'unknown');

  logger.debug(
    {
      chatId,
      messageId,
      from: displayName,
      text: (msg.text ?? msg.caption)?.slice(0, 80),
    },
    'Message received',
  );

  const e = env();
  const baseData = {
    type: 'message' as const,
    chatId,
    messageId,
    isEdit,
    update: ctx.update,
    enqueuedAt: Date.now(),
  };

  // ── 单一入口(P1):一切更新进回合缓冲,turn actor 是唯一路由 ──
  // edits 也加入 burst(不算 direct、不打断、不调 focus);WAIT/STOP 唤醒
  // 判断在 actor 内。legacy debounce 双路径已拆除 —— 两套合并引擎共存
  // 是接缝 bug 的温床(audit P1/P2 多条源于此)。
  if (isTurnActorChat(chatId)) {
    const isDirect = !isEdit && looksLikeDirectInteraction(ctx.update, {
      botUid: getBotUid(),
      botUsername: e.BOT_USERNAME,
      botNicknames: e.BOT_NICKNAMES,
    });

    if (!isEdit) {
      // G3: 打断同 chat 在飞生成(TURN_ABORT_ENABLED=false 时为 no-op)
      interruptGeneration(chatId, isDirect ? 'direct_message' : 'new_message');
      // G9: focus 事件(flag off 时 bumpFocus 自身为 no-op)
      if (chatId < 0) {
        void bumpFocus(chatId, isDirect ? 'direct_interaction' : 'passive_message').catch(() => {});
      }
    }

    // G4「还在打字」启发式:短消息 + 尾部无终止标点 → 延长去抖窗口
    const msgTextRaw = (msg.text ?? msg.caption ?? '').trim();
    const stillTyping =
      !isEdit &&
      msgTextRaw.length > 0 &&
      msgTextRaw.length < 60 &&
      !/[。.!?！？…~〜)）」』"”\]】]$/.test(msgTextRaw);

    await appendPending({
      update: ctx.update,
      chatId,
      messageId,
      enqueuedAt: Date.now(),
      direct: isDirect,
      isEdit,
    });
    await scheduleTurn(chatId, {
      trigger: isDirect ? 'direct' : 'message',
      direct: isDirect,
      stillTyping,
    });
    return;
  }

  // Default path (timing disabled, or edits): enqueue immediately
  await enqueue(baseData);
}

export function registerMessageHandler(bot: Bot): void {
  bot.on('message', handleUpdate);
  bot.on('edited_message', handleUpdate);
  bot.on('channel_post', handleUpdate);
  bot.on('edited_channel_post', handleUpdate);
}
