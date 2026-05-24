import { Bot } from 'grammy';
import { env } from '../env.js';
import { logger } from '../shared/logger.js';

let _bot: Bot | undefined;
let _botUid = 0;

export async function createBot(): Promise<Bot> {
  if (!_bot) {
    _bot = new Bot(env().BOT_TOKEN);

    // Initialize bot (required for webhook mode handleUpdate)
    await _bot.init();
    _botUid = _bot.botInfo.id;
    logger.info({ botUid: _botUid, username: _bot.botInfo.username }, 'Bot identity fetched');

    _bot.catch((err) => {
      logger.error({ err: err.error }, 'Bot error');
    });
  }
  return _bot;
}

export function getBotUid(): number {
  return _botUid;
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
  }
}
