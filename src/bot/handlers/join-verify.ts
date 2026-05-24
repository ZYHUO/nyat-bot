import type { Bot } from 'grammy';
import { logger } from '../../shared/logger.js';
import { getDb } from '../../db/sqlite.js';
import { getRedis } from '../../db/redis.js';
import * as store from '../../verification/store.js';
import { generateChallenge } from '../../verification/challenge.js';
import {
  buildChallengeKeyboard,
  parseVerifyCallback,
} from '../../verification/keyboard.js';

interface JoinVerifyDeps {
  aiCall: (systemPrompt: string, userMessage: string) => Promise<string | null>;
  masterUid: number;
}

/**
 * Restrict a user in a group (can_send_messages = false).
 */
async function restrictUser(
  bot: Bot,
  chatId: number,
  userId: number,
  allowed: boolean,
): Promise<boolean> {
  try {
    await bot.api.restrictChatMember(chatId, userId, {
        can_send_messages: allowed,
        can_send_audios: allowed,
        can_send_documents: allowed,
        can_send_photos: allowed,
        can_send_videos: allowed,
        can_send_video_notes: allowed,
        can_send_voice_notes: allowed,
        can_send_polls: allowed,
        can_send_other_messages: allowed,
        can_add_web_page_previews: allowed,
        can_change_info: allowed,
        can_invite_users: allowed,
        can_pin_messages: allowed,
        can_manage_topics: allowed,
    });
    return true;
  } catch (err) {
    logger.warn({ err, chatId, userId }, 'Failed to restrict user');
    return false;
  }
}

/**
 * Send verification DM to user.
 */
async function sendVerificationDM(
  bot: Bot,
  userId: number,
  chatId: number,
  chatTitle: string,
  challenge: import('../../verification/challenge.js').Challenge,
): Promise<number | null> {
  try {
    const msg = await bot.api.sendMessage(
      userId,
      `🔐 入群验证\n\n你正在申请加入「${chatTitle}」，请回答以下问题：\n\n❓ ${challenge.question}`,
      {
        reply_markup: buildChallengeKeyboard(challenge, chatId),
      },
    );
    return msg.message_id;
  } catch (err) {
    logger.warn({ err, userId, chatId }, 'Failed to send verification DM');
    return null;
  }
}

/**
 * Register join verification handlers.
 */
export function registerJoinVerifyHandler(
  bot: Bot,
  deps: JoinVerifyDeps,
): void {
  // ── Handle new members joining a group ──
  bot.on('message:new_chat_members', async (ctx) => {
    const chatId = ctx.chat?.id;
    const chatType = ctx.chat?.type;
    if (chatType !== 'group' && chatType !== 'supergroup') return;
    if (!chatId) return;

    const db = getDb();
    const settings = store.getVerifySettings(db, chatId);
    if (!settings?.enabled) return;

    const newMembers = ctx.message?.new_chat_members;
    if (!newMembers) return;

    for (const member of newMembers) {
      if (member.is_bot) continue;

      const userId = member.id;
      const username = member.username;
      const firstName = member.first_name;

      // Check if already verified recently (within 1 hour)
      const existing = store.getPendingRecord(db, chatId, userId);
      if (existing) continue;

      // Restrict user (skip for chat owners)
      let restricted = false;
      try {
        restricted = await restrictUser(bot, chatId, userId, false);
      } catch { /* ignore */ }
      const isOwner = !restricted;

      // Generate challenge
      const challenge = await generateChallenge(deps.aiCall);
      if (!challenge) {
        logger.warn({ chatId, userId }, 'Failed to generate challenge, unrestricting user');
        await restrictUser(bot, chatId, userId, true);
        continue;
      }

      // Create record
      const recordId = store.createVerifyRecord(db, {
        chat_id: chatId,
        user_id: userId,
        username,
        first_name: firstName,
        challenge,
        max_attempts: settings.max_attempts,
      });

      // Set Redis active verification flag (for DM interception)
      const redis = getRedis();
      await redis.set(
        `xxb:verify:active:${userId}`,
        JSON.stringify({ chatId, recordId, startedAt: Date.now() }),
        'EX',
        settings.timeout_seconds,
      );

      // Send DM
      const chatTitle = 'chat' in ctx ? (ctx.chat as { title?: string }).title ?? '未知群组' : '未知群组';
      const dmMsgId = await sendVerificationDM(bot, userId, chatId, chatTitle, challenge);

      if (dmMsgId) {
        store.updateDmMessageId(db, recordId, dmMsgId);
      }

      // Build group notification keyboard: [私聊验证] + [✅通过] [❌拒绝]
      const botUsername = ctx.me.username;
      const groupKeyboard = {
        inline_keyboard: [
          [{
            text: '💬 在私聊中验证',
            url: `https://t.me/${botUsername}?start=verify`,
          }],
          [
            { text: '✅ 通过', callback_data: `verify:admin_pass:${chatId}:${userId}` },
            { text: '❌ 拒绝', callback_data: `verify:admin_fail:${chatId}:${userId}` },
          ],
        ],
      };

      // Send group notification
      try {
        const ownerNote = isOwner ? ' 👑（群主，自动跳过禁言）' : '';
        const dmNote = dmMsgId ? '' : '\n⚠️ 无法私聊，请点击下方按钮开始验证';
        await bot.api.sendMessage(
          chatId,
          `🔐 ${firstName ?? '新成员'}${ownerNote} 正在等待入群验证...\n\n⏳ 验证中 | ⏱ ${settings.timeout_seconds}s 超时${dmNote}`,
          { reply_markup: groupKeyboard },
        );
      } catch { /* ignore */ }

      logger.info({ chatId, userId, recordId }, 'Verification started');
    }
  });

  // ── Handle deep link: /start verify ──
  // When user clicks "在私聊中验证" button in group notification
  bot.command('start', async (ctx) => {
    const payload = ctx.match?.trim();
    if (payload !== 'verify') return; // only handle ?start=verify

    if (!ctx.from) {
      await ctx.reply('❌ 无法识别验证用户，请重新从群里的验证按钮进入。');
      return;
    }

    const userId = ctx.from.id;
    const db = getDb();
    const redis = getRedis();

    // Check if user has an active verification
    const redisKey = `xxb:verify:active:${userId}`;
    const redisData = await redis.get(redisKey);
    if (!redisData) {
      await ctx.reply('✅ 你没有待完成的验证。如果刚加入群组，请等待几秒后重试。');
      return;
    }

    const { chatId } = JSON.parse(redisData) as { chatId: number; recordId: number };
    const record = store.getPendingRecord(db, chatId, userId);
    if (!record) {
      await ctx.reply('✅ 验证已过期或已完成。');
      await redis.del(redisKey);
      return;
    }

    // Get chat title
    let chatTitle = '未知群组';
    try {
      const chat = await bot.api.getChat(chatId);
      if ('title' in chat) chatTitle = chat.title ?? chatTitle;
    } catch { /* ignore */ }

    // Send verification challenge
    const challenge = JSON.parse(record.challenge_json) as import('../../verification/challenge.js').Challenge;
    try {
      const msg = await ctx.reply(
        `🔐 入群验证\n\n你正在申请加入「${chatTitle}」，请回答以下问题：\n\n❓ ${challenge.question}`,
        { reply_markup: buildChallengeKeyboard(challenge, chatId) },
      );
      store.updateDmMessageId(db, record.id, msg.message_id);
    } catch (err) {
      logger.warn({ err, userId, chatId }, 'Failed to send verification via deep link');
      await ctx.reply('❌ 发送验证失败，请稍后重试。');
    }
  });

  // ── Handle callback queries (answer selection + admin actions) ──
  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;
    const parsed = parseVerifyCallback(data);
    if (!parsed) return;

    const db = getDb();
    const redis = getRedis();
    const userId = ctx.from.id;

    // ── User answered a question ──
    if (parsed.action === 'a') {
      const chatId = parsed.chatId;
      const answerIdx = Number(parsed.value);

      const record = store.getPendingRecord(db, chatId, userId);
      if (!record) {
        await ctx.answerCallbackQuery({ text: '验证已过期或已完成', show_alert: true });
        return;
      }

      const challenge = JSON.parse(record.challenge_json) as import('../../verification/challenge.js').Challenge;
      const selectedAnswer = challenge.options[answerIdx];

      if (selectedAnswer === challenge.answer) {
        // ✅ Correct
        store.updateRecordStatus(db, record.id, 'passed');
        await restrictUser(bot, chatId, userId, true);
        await redis.del(`xxb:verify:active:${userId}`);

        try {
          await ctx.editMessageText('✅ 验证通过！你现在可以在群里发言了。');
        } catch { /* message may be too old */ }

        // Notify group
        try {
          const firstName = ctx.from.first_name ?? '用户';
          await bot.api.sendMessage(chatId, `✅ ${firstName} 已通过入群验证`);
        } catch { /* ignore */ }

        await ctx.answerCallbackQuery({ text: '✅ 验证通过！' });
        logger.info({ chatId, userId, recordId: record.id }, 'Verification passed');
      } else {
        // ❌ Wrong answer
        const newAttempts = record.attempts + 1;
        const failSettings = store.getVerifySettings(db, chatId);
        const failMaxAttempts = failSettings?.max_attempts ?? 3;

        if (newAttempts >= failMaxAttempts) {
          const settings = failSettings;
          // Failed — all attempts used
          store.updateRecordStatus(db, record.id, 'failed');
          await redis.del(`xxb:verify:active:${userId}`);

          if (settings?.kick_on_fail) {
            // Kick from group
            try {
              await bot.api.banChatMember(chatId, userId);
              await bot.api.unbanChatMember(chatId, userId);
              store.updateRecordStatus(db, record.id, 'kicked');
            } catch { /* ignore */ }
          } else {
            // Not kicking — unrestrict so they can at least speak
            await restrictUser(bot, chatId, userId, true);
          }

          try {
            await ctx.editMessageText(
              `❌ 验证失败，次数已用完（共 ${failMaxAttempts} 次）。\n\n请联系管理员或重新加入群组再试。`,
            );
          } catch { /* ignore */ }

          // Notify group
          try {
            const firstName = ctx.from.first_name ?? '用户';
            const action = settings?.kick_on_fail ? '已被移出群组' : '验证未通过';
            await bot.api.sendMessage(chatId, `❌ ${firstName} ${action}（验证失败）`);
          } catch { /* ignore */ }

          await ctx.answerCallbackQuery({ text: '❌ 验证失败', show_alert: true });
          logger.info({ chatId, userId, recordId: record.id, attempts: newAttempts }, 'Verification failed');
        } else {
          const settings = store.getVerifySettings(db, chatId);
          const maxAttempts = settings?.max_attempts ?? 3;
          // Generate new challenge
          const newChallenge = await generateChallenge(deps.aiCall);
          if (newChallenge) {
            store.incrementAttempt(db, record.id, newChallenge);

            try {
              const chatTitle = 'chat' in ctx ? (ctx.chat as { title?: string }).title ?? '未知群组' : '未知群组';
              await ctx.editMessageText(
                `🔐 入群验证（第 ${newAttempts + 1} 次）\n\n你正在申请加入「${chatTitle}」，请回答以下问题：\n\n❓ ${newChallenge.question}`,
                { reply_markup: buildChallengeKeyboard(newChallenge, chatId) },
              );
            } catch { /* ignore */ }
          }

          await ctx.answerCallbackQuery({ text: `❌ 答错了，还剩 ${maxAttempts - newAttempts} 次机会`, show_alert: true });
        }
      }
    }

    // ── Admin actions ──
    if (parsed.action === 'admin_pass' || parsed.action === 'admin_fail') {
      // Only master can use admin actions
      if (userId !== deps.masterUid) {
        await ctx.answerCallbackQuery({ text: '无权限', show_alert: true });
        return;
      }

      const targetUserId = Number(parsed.value);
      const chatId = parsed.chatId;
      const record = store.getPendingRecord(db, chatId, targetUserId);

      if (!record) {
        await ctx.answerCallbackQuery({ text: '验证记录不存在', show_alert: true });
        return;
      }

      if (parsed.action === 'admin_pass') {
        store.updateRecordStatus(db, record.id, 'passed');
        await restrictUser(bot, chatId, targetUserId, true);
        await redis.del(`xxb:verify:active:${targetUserId}`);

        try {
          await ctx.editMessageText('✅ 管理员已手动通过验证');
        } catch { /* ignore */ }

        try {
          await bot.api.sendMessage(chatId, `✅ 管理员已通过 ${record.first_name ?? '用户'} 的入群验证`);
        } catch { /* ignore */ }

        await ctx.answerCallbackQuery({ text: '✅ 已通过' });
      } else {
        store.updateRecordStatus(db, record.id, 'failed');
        await restrictUser(bot, chatId, targetUserId, true);
        await redis.del(`xxb:verify:active:${targetUserId}`);

        try {
          await ctx.editMessageText('❌ 管理员已拒绝验证');
        } catch { /* ignore */ }

        await ctx.answerCallbackQuery({ text: '❌ 已拒绝' });
      }
    }
  });
}
