import { env } from '../env.js';
import { getRedis } from '../db/redis.js';
import { isGroupAllowed } from '../allowlist/allowlist.js';
import { configFromEnv } from '../allowlist/bot-flow.js';
import { getSleepPhase } from '../tracking/sleep.js';
import { isTelegramHeartBatchChat } from './flags.js';
import { heartRoute, hasTimedBypass } from './heart-route.js';

export async function telegramHeartBatchPolicyCurrent(chatId: number): Promise<boolean> {
  const config = env();
  if (!isTelegramHeartBatchChat(chatId) || heartRoute(config, chatId) !== 'heart') return false;
  return await isGroupAllowed(getRedis(), configFromEnv(config), chatId)
    && !await hasTimedBypass(chatId, true) && await getSleepPhase(undefined, true, true) === 'awake';
}
