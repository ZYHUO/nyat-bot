import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { parseReplyResponse } from '../../../src/pipeline/reply/parser.js';
import { normalizeReactionEmoji } from '../../../src/pipeline/reply/reaction-emoji.js';

const FALLBACK = 42;

describe('G2 action-space parsing', () => {
  it('parses a react action with allowed emoji', () => {
    const out = parseReplyResponse('[{"action":"react","targetMessageId":7,"emoji":"😁"}]', FALLBACK);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ action: 'react', emoji: '😁', targetMessageId: 7 });
  });

  it('normalizes variation selectors (❤️ → ❤)', () => {
    expect(normalizeReactionEmoji('❤️')).toBe('❤');
    expect(normalizeReactionEmoji('🤣')).toBe('🤣');
    expect(normalizeReactionEmoji('💩')).toBe(null); // not in Telegram's set... actually it is, but not in ours
  });

  it('drops a react with non-allowed emoji but keeps the rest of the array', () => {
    const out = parseReplyResponse(
      '[{"action":"react","targetMessageId":7,"emoji":"🦄"},{"replyContent":"还是说两句","targetMessageId":8}]',
      FALLBACK,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.replyContent).toBe('还是说两句');
  });

  it('parses a silent action', () => {
    const out = parseReplyResponse('[{"action":"silent"}]', FALLBACK);
    expect(out).toHaveLength(1);
    expect(out[0]!.action).toBe('silent');
    expect(out[0]!.replyContent).toBe('');
  });

  it('a lone malformed action degrades to silent (never leaks raw JSON)', () => {
    const out = parseReplyResponse('{"action":"react","emoji":"🦄","targetMessageId":7}', FALLBACK);
    expect(out).toHaveLength(1);
    expect(out[0]!.action).toBe('silent');
  });

  it('parses a sticker action as a [sticker] bubble with intents', () => {
    const out = parseReplyResponse('[{"action":"sticker","stickerIntent":["laughing"],"targetMessageId":9}]', FALLBACK);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      action: 'sticker',
      replyContent: '[sticker]',
      stickerIntent: ['laughing'],
      targetMessageId: 9,
    });
  });

  it('mixed array: react + text reply', () => {
    const out = parseReplyResponse(
      '[{"action":"react","targetMessageId":7,"emoji":"🔥"},{"replyContent":"这个太强了","targetMessageId":8}]',
      FALLBACK,
    );
    expect(out).toHaveLength(2);
    expect(out[0]!.action).toBe('react');
    expect(out[1]!.action).toBeUndefined();
  });

  it('plain text replies stay untouched (no action field)', () => {
    const out = parseReplyResponse('{"replyContent":"普通回复","targetMessageId":5}', FALLBACK);
    expect(out[0]!.action).toBeUndefined();
  });
});
