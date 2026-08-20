import type { Context, NextFunction } from 'grammy';
import { getRedis } from '../../db/redis.js';
import * as allowlist from '../../allowlist/allowlist.js';
import type { AllowlistConfig } from '../../allowlist/types.js';

export function createAllowlistMiddleware(config: AllowlistConfig) {
  return async function allowlistMiddleware(
    ctx: Context,
    next: NextFunction,
  ): Promise<void> {
    const chatType = ctx.chat?.type;
    if (chatType !== 'group' && chatType !== 'supergroup') {
      return next();
    }

    // my_chat_member 必须放行：入群提示/入群自动审核都靠这个 update——
    // 拦住它等于新群永远收不到引导（2026-08-20 发现的存量拦截 bug）。
    if (ctx.myChatMember) return next();

    if (!config.enabled) return next();

    const chatId = ctx.chat!.id;
    const redis = getRedis();
    const allowed = await allowlist.isGroupAllowed(redis, config, chatId);

    if (!allowed) return;

    return next();
  };
}
