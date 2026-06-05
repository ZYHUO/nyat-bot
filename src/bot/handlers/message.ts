import type { Bot, Context } from 'grammy';
import { logger } from '../../shared/logger.js';
import { isDuplicate } from '../middleware/dedup.js';
import { isRateLimited } from '../middleware/rate-limit.js';
import { enqueue } from '../../queue/producer.js';
import { enqueueWithDebounce, flushBuffer } from '../../pipeline/timing/debounce.js';
import { looksLikeDirectInteraction } from '../../pipeline/timing/direct-interaction.js';
import { getChatState, transitionToRunning } from '../../pipeline/timing/chat-runtime.js';
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

  // ── Turn-actor ingress path (G1) ──
  // 消息不再各自成 job:写入 pending 缓冲 → 排程(或续期)该 chat 的认知
  // 回合。WAIT/STOP 的唤醒判断移入 actor。edits 仍走旧路径(罕见且幂等)。
  if (!isEdit && isTurnActorChat(chatId)) {
    const isDirect = looksLikeDirectInteraction(ctx.update, {
      botUid: getBotUid(),
      botUsername: e.BOT_USERNAME,
      botNicknames: e.BOT_NICKNAMES,
    });

    // G3: 打断同 chat 在飞生成(TURN_ABORT_ENABLED=false 时为 no-op)
    interruptGeneration(chatId, isDirect ? 'direct_message' : 'new_message');

    // G9: focus 事件(flag off 时 bumpFocus 自身为 no-op)
    if (chatId < 0) {
      void bumpFocus(chatId, isDirect ? 'direct_interaction' : 'passive_message').catch(() => {});
    }

    // G4「还在打字」启发式:短消息 + 尾部无终止标点 → 用户多半还有下文,
    // 延长去抖窗口让整波念头落完再开回合。
    const msgTextRaw = (msg.text ?? msg.caption ?? '').trim();
    const stillTyping =
      msgTextRaw.length > 0 &&
      msgTextRaw.length < 60 &&
      !/[。.!?！？…~〜)）」』"”\]】]$/.test(msgTextRaw);

    await appendPending({
      update: ctx.update,
      chatId,
      messageId,
      enqueuedAt: Date.now(),
      direct: isDirect,
    });
    await scheduleTurn(chatId, {
      trigger: isDirect ? 'direct' : 'message',
      direct: isDirect,
      stillTyping,
    });
    return;
  }

  // ── Timing-gate aware enqueue path ──
  if (e.TIMING_GATE_ENABLED && !isEdit) {
    const isDirect = looksLikeDirectInteraction(ctx.update, {
      botUid: getBotUid(),
      botUsername: e.BOT_USERNAME,
      botNicknames: e.BOT_NICKNAMES,
    });

    let chatState;
    try {
      chatState = await getChatState(chatId);
    } catch (err) {
      logger.warn({ err, chatId }, 'getChatState failed, treating as RUNNING');
      chatState = { state: 'RUNNING' as const };
    }

    // Wake-up: direct interaction during WAIT/STOP forces back to RUNNING.
    // Also flush any pending debounce buffer so older messages are processed.
    if (
      isDirect &&
      (chatState.state === 'WAIT' || chatState.state === 'STOP')
    ) {
      try {
        await transitionToRunning(chatId);
      } catch (err) {
        logger.warn({ err, chatId }, 'Wake-up transitionToRunning failed');
      }
      await flushBuffer(chatId, 'direct_interaction');
      await enqueue(baseData);
      return;
    }

    // Suppressed: chat in WAIT/STOP and message is not a wake-up.
    // Enqueue tracking-only — pipeline will store context but skip judge/reply.
    if (chatState.state === 'WAIT' || chatState.state === 'STOP') {
      await enqueue({ ...baseData, skipReply: true });
      return;
    }

    // RUNNING + direct interaction: bypass debounce, immediate enqueue
    if (isDirect) {
      await enqueueWithDebounce(baseData, { bypassDebounce: true });
      return;
    }

    // RUNNING + passive message: route through debounce buffer
    if (e.TIMING_DEBOUNCE_MS > 0) {
      await enqueueWithDebounce(baseData);
      return;
    }
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
