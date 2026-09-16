import type { Bot } from 'grammy';
import { logger } from '../shared/logger.js';
import type { AllowlistConfig } from './types.js';
import * as allowlist from './allowlist.js';
import type { Redis } from 'ioredis';

export async function onBotJoinedGroup(
  bot: Bot,
  redis: Redis,
  config: AllowlistConfig,
  chatId: number,
): Promise<void> {
  if (!config.enabled) {
    await safeSend(bot, chatId, '⚠️ 白名单功能未开启，Bot 可能无法正常使用。');
    return;
  }

  const group = await allowlist.getGroupRecord(redis, config, chatId);
  if (group?.approved && group?.enabled) {
    await safeSend(bot, chatId, '✅ Bot 已就绪，可以正常使用了！');
    return;
  }

  const pending = await allowlist.listPending(redis, config);
  const hasPending = pending.some((p) => p.chat_id === chatId);

  if (hasPending) {
    await safeSend(bot, chatId, '⏳ 本群的开通申请正在审核中，请耐心等待喵。');
  } else {
    await safeSend(
      bot,
      chatId,
      '📋 本群还没开通白名单。请群主或管理员私聊我，把本群 ID 或 @群username 发给我就能申请，我会自动审核喵～',
    );
  }
}

export async function afterApproved(
  bot: Bot,
  chatId: number,
  enabled: boolean,
): Promise<void> {
  if (enabled) {
    await safeSend(
      bot,
      chatId,
      '✅ 恭喜！本群的白名单申请已通过审核，Bot 已启用。',
    );
  } else {
    await safeSend(
      bot,
      chatId,
      '✅ 本群的白名单申请已通过审核。管理员可在 Mini App 中启用 Bot。',
    );
  }
}

export async function afterToggleEnabled(
  bot: Bot,
  chatId: number,
  enabled: boolean,
): Promise<void> {
  if (enabled) {
    await safeSend(bot, chatId, '🔔 Bot 已在本群启用。');
  } else {
    await safeSend(bot, chatId, '🔕 Bot 已在本群暂停服务。');
  }
}

export async function afterRemovedFromAllowlist(
  bot: Bot,
  chatId: number,
): Promise<void> {
  await safeSend(bot, chatId, '❌ 本群已从白名单中移除，Bot 将停止服务。');
}

async function safeSend(
  bot: Bot,
  chatId: number,
  text: string,
): Promise<void> {
  try {
    await bot.api.sendMessage(chatId, text);
  } catch (err) {
    logger.warn({ err, chatId }, 'AllowlistNotify: failed to send message');
  }
}
