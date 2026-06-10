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
  // edits 也加入 burst,但按**内容**判 direct:typo 修正是被动入册,
  // 改出 @bot/回复 bot 的编辑仍算点名(review #0/#8)。被动编辑不打断、
  // 不调 focus、不滑动去抖窗口。legacy debounce 双路径已拆除 —— 两套
  // 合并引擎共存是接缝 bug 的温床(audit P1/P2 多条源于此)。
  if (isTurnActorChat(chatId)) {
    const isDirect = looksLikeDirectInteraction(ctx.update, {
      botUid: getBotUid(),
      botUsername: e.BOT_USERNAME,
      botNicknames: e.BOT_NICKNAMES,
      editByContentOnly: true,
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
      // 被动编辑不滑动去抖窗口:changeDelay 是"从现在起重新计时",连续
      // 改 typo 会把真消息的回合一直往后推(review #2)。已有排程时由它
      // 一并 drain;没有排程才新建(让编辑内容及时入册)。
      noReschedule: isEdit && !isDirect,
    });
    return;
  }

  // Default path (turn actor disabled / chat outside graylist): enqueue immediately
  await enqueue(baseData);
}

export function registerMessageHandler(bot: Bot): void {
  // review #6:graylist 非空时,名单外的群直接 enqueue —— 没有去抖、没有
  // WAIT/STOP 抑制(legacy debounce 路径已删)。这是灰度专用的退化模式,
  // 启动时显式提醒,免得 A/B 结束后忘了清名单。
  const e = env();
  if (e.TURN_ACTOR_ENABLED && e.TURN_ACTOR_CHAT_IDS.length > 0) {
    logger.warn(
      { graylist: e.TURN_ACTOR_CHAT_IDS },
      'TURN_ACTOR_CHAT_IDS 非空:名单外的 chat 将绕过 turn actor 直接入队(无去抖/无 WAIT-STOP 抑制)',
    );
  }
  bot.on('message', handleUpdate);
  bot.on('edited_message', handleUpdate);
  bot.on('channel_post', handleUpdate);
  bot.on('edited_channel_post', handleUpdate);
}
