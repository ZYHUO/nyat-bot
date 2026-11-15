import { describe, expect, it, vi } from 'vitest';
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => { throw new Error('ID guard must not query DB'); } }));
import { assertTelegramPayload } from '../../../src/platform/telegram-guard.js';

const reserved = 2 ** 52 + 1;
describe('Telegram final API boundary', () => {
  it.each([
    { chat_id: reserved }, { chat_id: -reserved }, { user_id: String(reserved) },
    { chat_id: 2 ** 52 }, { chat_id: Number.MAX_SAFE_INTEGER + 100 },
    { chat_id: `+${reserved}` }, { chat_id: ` ${reserved} ` }, { chat_id: '4.6e15' },
    { chat_id: -100, from_chat_id: -reserved },
    { chat_id: -100, message_ids: [1, reserved] },
    { chat_id: -100, message_ids: `[1,${reserved}]` },
    { chat_id: -100, reply_parameters: { message_id: reserved } },
    { chat_id: -100, reply_parameters: JSON.stringify({ message_id: reserved }) },
    { chat_id: -100, entities: [{ type: 'text_mention', user: { id: reserved } }] },
    { chat_id: -100, reply_markup: JSON.stringify({ keyboard: [[{ request_users: { user_ids: [reserved] } }]] }) },
    { chat_id: -100, media: JSON.stringify([{ type: 'photo', media: 'qq:image:asset' }]) },
    { file_id: 'qq:file:asset' }, { photo: 'qq-image-asset' }, { voice: 'qq://voice/asset' },
  ])('rejects foreign identifiers/assets before transport: %#', (payload) => {
    expect(() => assertTelegramPayload(payload)).toThrow();
  });

  it('preserves native Telegram IDs, usernames, uploads and text that only discusses a number', () => {
    for (const payload of [
      { chat_id: -10012345, user_id: 99999, message_id: 123, message_ids: [123, 124] },
      { chat_id: '@channel', text: `reference ${reserved}`, reply_parameters: { message_id: 1 } },
      { file_id: 'AgACAgUAAxkBAA...', photo: Buffer.from('image-bytes') },
      { chat_id: 1, reply_markup: JSON.stringify({ inline_keyboard: [[{ text: 'button', callback_data: 'normal' }]] }) },
    ]) expect(() => assertTelegramPayload(payload)).not.toThrow();
  });
});
