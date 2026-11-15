import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationRef } from '../../../src/platform/types.js';

const mocks = vi.hoisted(() => ({
  use: vi.fn(), init: vi.fn(), stop: vi.fn(async () => {}), findConversationRef: vi.fn(),
  getOrCreateUserId: vi.fn(),
}));
vi.mock('grammy', () => ({
  Bot: class {
    api = { config: { use: mocks.use } };
    botInfo = { id: 123, username: 'telegram_bot', first_name: 'Telegram Bot' };
    init = mocks.init;
    stop = mocks.stop;
    catch() {}
  },
}));
vi.mock('../../../src/env.js', () => ({ env: () => ({ BOT_TOKEN: 'test-token', BOT_USERNAME: 'fallback_bot', BOT_NICKNAMES: ['啾咪', '小喵'] }) }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { info: vi.fn(), error: vi.fn() } }));
vi.mock('../../../src/platform/identity-store.js', () => ({
  findConversationRef: mocks.findConversationRef, getOrCreateUserId: mocks.getOrCreateUserId,
  isPlatformInternalId: (id: number | string) => Number.isInteger(Number(id)) && Math.abs(Number(id)) >= 2 ** 52,
}));
import { createBot, stopBot, getBotIdentity, getBotUid, getBotUsername, getBotDisplayName } from '../../../src/bot/bot.js';

const chatId = -(2 ** 52 + 1);
const qqSelf = 2 ** 52 + 2;
const qq: ConversationRef = { platform: 'qq', accountId: '80001', idNamespace: 'qq-number', conversationKind: 'group', id: '70001' };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.findConversationRef.mockReturnValue(qq);
  mocks.getOrCreateUserId.mockReturnValue(qqSelf);
  mocks.init.mockImplementation(async () => { expect(mocks.use).toHaveBeenCalledTimes(1); });
});
afterEach(async () => { await stopBot(); });

describe('bot-wide platform isolation', () => {
  it('installs the guard before init and blocks every raw API method independent of sender wrappers', async () => {
    await createBot();
    const transform = mocks.use.mock.calls[0]![0] as (previous: (...args: unknown[]) => Promise<unknown>, method: string, payload: unknown, signal?: unknown) => Promise<unknown>;
    const network = vi.fn(async () => ({ ok: true, result: true }));
    for (const method of ['sendMessage', 'sendPoll', 'sendPhoto', 'editMessageText', 'deleteMessage',
      'setMessageReaction', 'getChat', 'getChatMember', 'banChatMember', 'getChatAdministrators']) {
      await expect(transform(network, method, { chat_id: chatId })).rejects.toMatchObject({ code: 'telegram_platform_id_blocked' });
    }
    await expect(transform(network, 'restrictChatMember', { chat_id: -100, user_id: qqSelf })).rejects.toMatchObject({ code: 'telegram_platform_id_blocked' });
    expect(network).not.toHaveBeenCalled();
    await transform(network, 'sendMessage', { chat_id: -100, text: 'normal' });
    expect(network).toHaveBeenCalledExactlyOnceWith('sendMessage', { chat_id: -100, text: 'normal' }, undefined);
  });

  it('resolves QQ self within its account without mutating Telegram identity', async () => {
    await createBot();
    expect(getBotUid(chatId)).toBe(qqSelf);
    expect(getBotUsername(chatId)).toBe('');
    expect(getBotDisplayName(chatId)).toBe('啾咪');
    expect(getBotIdentity(chatId)).toEqual({ uid: qqSelf, username: '', displayName: '啾咪', nicknames: ['啾咪', '小喵'] });
    expect(mocks.getOrCreateUserId).toHaveBeenCalledWith({ platform: 'qq', accountId: '80001', idNamespace: 'qq-number', id: '80001' });
    expect(getBotIdentity(-100)).toEqual({ uid: 123, username: 'telegram_bot', displayName: 'Telegram Bot', nicknames: ['Telegram Bot', '啾咪', '小喵'] });
    expect(getBotUid()).toBe(123);
  });

  it('fails closed for unknown reserved conversations instead of returning Telegram self', () => {
    mocks.findConversationRef.mockReturnValue(null);
    expect(() => getBotIdentity(chatId)).toThrow('Platform chat identity is unavailable');
    expect(mocks.getOrCreateUserId).not.toHaveBeenCalled();
  });
});
