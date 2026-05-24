import { getBot } from '../../bot/bot.js';

export async function executePoll(
  chatId: number,
  question: string,
  options: string[],
): Promise<string> {
  const bot = getBot();
  await bot.api.sendPoll(chatId, question, options, { is_anonymous: true });
  return `投票已创建：${question}`;
}
