import { Bot } from 'grammy';
import { env } from '../env.js';
import { logger } from '../shared/logger.js';

let _bot: Bot | undefined;
let _botUid = 0;
let _botUsername = '';
let _botDisplayName = '';

export async function createBot(): Promise<Bot> {
  if (!_bot) {
    _bot = new Bot(env().BOT_TOKEN);

    // Initialize bot (required for webhook mode handleUpdate)
    await _bot.init();
    _botUid = _bot.botInfo.id;
    _botUsername = _bot.botInfo.username ?? '';
    _botDisplayName = _bot.botInfo.first_name ?? '';
    logger.info(
      { botUid: _botUid, username: _botUsername, displayName: _botDisplayName },
      'Bot identity fetched',
    );

    _bot.catch((err) => {
      logger.error({ err: err.error }, 'Bot error');
    });
  }
  return _bot;
}

export function getBotUid(): number {
  return _botUid;
}

export function getBotUsername(): string {
  return _botUsername || env().BOT_USERNAME;
}

export function getBotDisplayName(): string {
  return _botDisplayName || env().BOT_NICKNAMES[0] || getBotUsername();
}

export function getBotIdentity(): { uid: number; username: string; displayName: string; nicknames: string[] } {
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
    await _bot.stop();
    _bot = undefined;
    _botUid = 0;
    _botUsername = '';
    _botDisplayName = '';
  }
}
