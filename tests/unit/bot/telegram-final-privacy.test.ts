import { describe, expect, it, vi } from 'vitest';
type Transformer = (next: (...args: unknown[]) => Promise<unknown>, method: string, payload: unknown, signal?: unknown) => Promise<unknown>;
const fixture = vi.hoisted(() => ({ transform: undefined as Transformer | undefined }));
vi.mock('grammy', () => ({ Bot: class {
  api = { config: { use: (fn: Transformer) => { fixture.transform = fn; } } };
  botInfo = { id: 123, username: 'synthetic_bot', first_name: 'Synthetic' };
  async init() {}
  catch() {}
} }));
vi.mock('../../../src/env.js', () => ({ env: () => ({ BOT_TOKEN: '123:SYNTHETIC_TEST_TOKEN', BOT_NICKNAMES: [] }) }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { info: vi.fn(), error: vi.fn() } }));
import { createBot } from '../../../src/bot/bot.js';

describe('actual Telegram API middleware privacy boundary', () => {
  it('blocks raw text, nested captions and cross-chat copy/forward before transport', async () => {
    await createBot();
    const next = vi.fn(async () => ({ ok: true }));
    const secret = `sk-${'synthetic_privacy_canary_'.repeat(2)}`;
    for (const [method, payload] of [
      ['sendMessage', { chat_id: -100, text: secret }],
      ['sendMediaGroup', { chat_id: -100, media: [{ type: 'photo', caption: secret }] }],
      ['editMessageText', { chat_id: -100, message_id: 1, text: secret }],
      ['forwardMessage', { chat_id: -100, from_chat_id: -200, message_id: 1 }],
      ['copyMessages', { chat_id: -100, from_chat_id: 123, message_ids: [1, 2] }],
    ] as const) await expect(fixture.transform!(next, method, payload)).rejects.toThrow('outbound_privacy_blocked');
    expect(next).not.toHaveBeenCalled();
    await expect(fixture.transform!(next, 'sendMessage', { chat_id: -100, text: '每人14元。' })).resolves.toEqual({ ok: true });
    await expect(fixture.transform!(next, 'forwardMessage', { chat_id: -100, from_chat_id: -100, message_id: 1 })).resolves.toEqual({ ok: true });
    expect(next).toHaveBeenCalledTimes(2);
  });
});
