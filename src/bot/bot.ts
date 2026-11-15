import { Bot } from 'grammy';
import { HttpsProxyAgent } from 'hpagent';
import { env } from '../env.js';
import { logger } from '../shared/logger.js';
import { assertTelegramPayload } from '../platform/telegram-guard.js';
import { getPlatformBotIdentity } from '../platform/account-context.js';
import { assertOutboundPayload, assertSameConversationForward } from '../shared/outbound-privacy.js';
import { installDurablePollingErrorHandler } from '../ingress/durable.js';
import { cancelBotPollingRetries, drainBotPolling } from '../ingress/polling-lifecycle.js';

let _bot: Bot | undefined;
let _botUid = 0;
let _botUsername = '';
let _botDisplayName = '';

export async function createBot(): Promise<Bot> {
  if (!_bot) {
    const e = env();
    const clientOpt = e.GLOBAL_FETCH_PROXY
      ? { baseFetchConfig: { agent: new HttpsProxyAgent({ proxy: e.GLOBAL_FETCH_PROXY, keepAlive: true }) } }
      : {};
    _bot = new Bot(e.BOT_TOKEN, { client: clientOpt });
    _bot.api.config.use(async (previous, method, payload, signal) => {
      assertTelegramPayload(payload);
      if (/^(?:forward|copy)Messages?$/.test(method)) {
        const source = payload as unknown as Record<string, unknown>;
        assertSameConversationForward(source['chat_id'], source['from_chat_id']);
      }
      if (/^(?:send|edit|answerInlineQuery)/.test(method)) assertOutboundPayload(payload);
      return previous(method, payload, signal);
    });

    // Initialize bot (required for webhook mode handleUpdate)
    await _bot.init();
    _botUid = _bot.botInfo.id;
    _botUsername = _bot.botInfo.username ?? '';
    _botDisplayName = _bot.botInfo.first_name ?? '';
    logger.info(
      { botUid: _botUid, username: _botUsername, displayName: _botDisplayName },
      'Bot identity fetched',
    );

    installDurablePollingErrorHandler(_bot, (err) => {
      logger.error({ err: err.error }, 'Bot error');
    });
  }
  return _bot;
}

export function getBotUid(chatId?: number): number {
  return getPlatformBotIdentity(chatId, env().BOT_NICKNAMES ?? [], env().ONEBOT_DISPLAY_NAME)?.uid ?? _botUid;
}

export function getBotUsername(chatId?: number): string {
  const identity = getPlatformBotIdentity(chatId, env().BOT_NICKNAMES ?? [], env().ONEBOT_DISPLAY_NAME);
  if (identity) return identity.username;
  return _botUsername || env().BOT_USERNAME;
}

export function getBotDisplayName(chatId?: number): string {
  const identity = getPlatformBotIdentity(chatId, env().BOT_NICKNAMES ?? [], env().ONEBOT_DISPLAY_NAME);
  if (identity) return identity.displayName;
  return _botDisplayName || env().BOT_NICKNAMES[0] || getBotUsername();
}

export function getBotIdentity(chatId?: number): { uid: number; username: string; displayName: string; nicknames: string[] } {
  const identity = getPlatformBotIdentity(chatId, env().BOT_NICKNAMES ?? [], env().ONEBOT_DISPLAY_NAME);
  if (identity) return identity;
  const username = getBotUsername();
  const displayName = getBotDisplayName();
  const configuredNicknames = env().BOT_NICKNAMES.map((name) => name.trim()).filter(Boolean);
  return {
    uid: _botUid,
    username,
    displayName,
    nicknames: [...new Set([displayName, ...configuredNicknames])],
  };
}

export function getBot(): Bot {
  if (!_bot) throw new Error('Bot not initialized. Call createBot() first.');
  return _bot;
}

/** Safe version that returns undefined instead of throwing (for shutdown-safe checks) */
export function tryGetBot(): Bot | undefined {
  return _bot;
}

export async function stopBot(): Promise<void> {
  if (_bot) {
    await stopBotIngress();
    _bot = undefined;
    _botUid = 0;
    _botUsername = '';
    _botDisplayName = '';
  }
}
/** Stop and join polling, retaining the API and identity until workers drain. */
export async function stopBotIngress(): Promise<void> {
  cancelBotPollingRetries();
  if (_bot) await _bot.stop();
  await drainBotPolling();
}
