import { describe, expect, it, vi } from 'vitest';
const transport = vi.hoisted(() => ({ getBot: vi.fn(), getRedis: vi.fn() }));
vi.mock('../../../src/bot/bot.js', () => ({ getBot: transport.getBot }));
vi.mock('../../../src/db/redis.js', () => ({ getRedis: transport.getRedis }));
import { sendMessage, sendPoll, editMessage, forwardMessage } from '../../../src/bot/sender/telegram.js';

describe('Telegram sender privacy before formatting, caching or transport', () => {
  it('blocks text, edits and poll fields without network calls', async () => {
    const secret = `sk-${'synthetic_privacy_canary_'.repeat(2)}`;
    await expect(sendMessage(-100, secret)).rejects.toThrow('outbound_privacy_blocked');
    await expect(editMessage(-100, 10, secret)).rejects.toThrow('outbound_privacy_blocked');
    await expect(sendPoll(-100, '问题', ['正常选项', secret])).rejects.toThrow('outbound_privacy_blocked');
    await expect(forwardMessage(-100, -200, 10)).rejects.toThrow('outbound_privacy_blocked');
    expect(transport.getBot).not.toHaveBeenCalled();
    expect(transport.getRedis).not.toHaveBeenCalled();
  });
});
