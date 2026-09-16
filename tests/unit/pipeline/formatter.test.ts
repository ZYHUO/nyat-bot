import { describe, it, expect } from 'vitest';
import { formatMessage } from '../../../src/pipeline/formatter.js';

function makeTgUpdate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    update_id: 1,
    message: {
      message_id: 42,
      from: { id: 1001, is_bot: false, first_name: 'Alice', last_name: 'Wang', username: 'alice' },
      chat: { id: -1001, type: 'supergroup' },
      date: 1700000000,
      ...overrides,
    },
  };
}

describe('formatMessage', () => {
  it('formats a plain text message', () => {
    const msg = formatMessage(makeTgUpdate({ text: 'Hello world' }));
    expect(msg).not.toBeNull();
    expect(msg!.role).toBe('user');
    expect(msg!.uid).toBe(1001);
    expect(msg!.username).toBe('alice');
    expect(msg!.fullName).toBe('Alice Wang');
    expect(msg!.timestamp).toBe(1700000000);
    expect(msg!.messageId).toBe(42);
    expect(msg!.textContent).toBe('Hello world');
    expect(msg!.isForwarded).toBe(false);
    expect(msg!.isBot).toBe(false);
  });

  it('formats a caption message', () => {
    const msg = formatMessage(makeTgUpdate({ caption: 'nice pic' }));
    expect(msg).not.toBeNull();
    expect(msg!.captionContent).toBe('nice pic');
  });

  it('formats a sticker message', () => {
    const msg = formatMessage(makeTgUpdate({
      sticker: { file_id: 'stk_123', file_unique_id: 'u1', emoji: '😊', set_name: 'HappySet' },
    }));
    expect(msg).not.toBeNull();
    expect(msg!.sticker).toEqual({
      emoji: '😊',
      fileId: 'stk_123',
      fileUniqueId: 'u1',
      setName: 'HappySet',
      isAnimated: undefined,
      isVideo: undefined,
    });
  });

  it('formats a reply message', () => {
    const msg = formatMessage(makeTgUpdate({
      text: 'I agree',
      reply_to_message: {
        message_id: 40,
        from: { id: 1002, is_bot: false, first_name: 'Bob' },
        chat: { id: -1001, type: 'supergroup' },
        date: 1699999000,
        text: 'What do you think about this feature? It seems very useful for our use case.',
      },
    }));
    expect(msg).not.toBeNull();
    expect(msg!.replyTo).toBeDefined();
    expect(msg!.replyTo!.messageId).toBe(40);
    expect(msg!.replyTo!.uid).toBe(1002);
    expect(msg!.replyTo!.fullName).toBe('Bob');
    expect(msg!.replyTo!.textSnippet.length).toBeLessThanOrEqual(80);
  });

  it('formats a forwarded message', () => {
    const msg = formatMessage(makeTgUpdate({
      text: 'forwarded stuff',
      forward_from: { id: 2000, is_bot: false, first_name: 'Charlie' },
      forward_date: 1699000000,
    }));
    expect(msg).not.toBeNull();
    expect(msg!.isForwarded).toBe(true);
    expect(msg!.forwardFrom).toBe('Charlie');
  });

  it('formats an image message (picks largest photo)', () => {
    const msg = formatMessage(makeTgUpdate({
      caption: 'look at this',
      photo: [
        { file_id: 'small', file_unique_id: 's1', width: 100, height: 100 },
        { file_id: 'large', file_unique_id: 'l1', width: 1280, height: 720 },
        { file_id: 'medium', file_unique_id: 'm1', width: 320, height: 240 },
      ],
    }));
    expect(msg).not.toBeNull();
    expect(msg!.imageFileId).toBe('large');
  });

  it('formats a bot message', () => {
    const msg = formatMessage({
      update_id: 2,
      message: {
        message_id: 50,
        from: { id: 5000, is_bot: true, first_name: 'SomeBot', username: 'some_bot' },
        chat: { id: -1001, type: 'supergroup' },
        date: 1700000100,
        text: 'Automated message',
      },
    });
    expect(msg).not.toBeNull();
    expect(msg!.isBot).toBe(true);
    expect(msg!.uid).toBe(5000);
  });

  it('returns null for update without message', () => {
    const msg = formatMessage({ update_id: 3 });
    expect(msg).toBeNull();
  });

  it('returns null for message without from', () => {
    const msg = formatMessage({
      update_id: 4,
      message: { message_id: 60, chat: { id: -1001, type: 'supergroup' }, date: 1700000200 },
    });
    expect(msg).toBeNull();
  });

  it('handles edited_message', () => {
    const msg = formatMessage({
      update_id: 5,
      edited_message: {
        message_id: 70,
        from: { id: 1001, is_bot: false, first_name: 'Alice' },
        chat: { id: -1001, type: 'supergroup' },
        date: 1700000300,
        text: 'edited text',
      },
    });
    expect(msg).not.toBeNull();
    expect(msg!.textContent).toBe('edited text');
  });

  it('captures inline keyboard buttons (callback / url) from another bot reply', () => {
    const msg = formatMessage(makeTgUpdate({
      from: { id: 555, is_bot: true, first_name: 'GeoBot', username: 'uzumaru_geoip_bot' },
      text: '🔍 查询中',
      reply_markup: {
        inline_keyboard: [
          [{ text: '确认身份', callback_data: 'verify:1' }],
          [{ text: '详情', url: 'https://example.com/x' }],
        ],
      },
    }));
    expect(msg).not.toBeNull();
    expect(msg!.inlineKeyboard).toEqual([
      { text: '确认身份', callbackData: 'verify:1' },
      { text: '详情', url: 'https://example.com/x' },
    ]);
  });

  it('no inlineKeyboard field when message has no reply_markup', () => {
    const msg = formatMessage(makeTgUpdate({ text: 'plain' }));
    expect(msg!.inlineKeyboard).toBeUndefined();
  });
});
