import { describe, expect, it } from 'vitest';
import {
  buildL0ContentDirection,
  isBarePingText,
  isShortFollowUpText,
  replyToFromPayload,
} from '../../../src/meta/reply-context.js';

describe('reply-context', () => {
  it('detects bare @ pings', () => {
    expect(isBarePingText('@hunhebi_bot')).toBe(true);
    expect(isBarePingText('@hunhebi_bot~')).toBe(true);
    expect(isBarePingText('')).toBe(true);
    expect(isBarePingText('这个怎么看')).toBe(false);
    expect(isBarePingText('@hunhebi_bot 怎么看')).toBe(false);
  });

  it('detects short follow-ups that need prior turn', () => {
    expect(isShortFollowUpText('快点告诉我')).toBe(true);
    expect(isShortFollowUpText('为什么')).toBe(true);
    expect(isShortFollowUpText('然后呢')).toBe(true);
    expect(isShortFollowUpText('@hunhebi_bot')).toBe(false);
    expect(isShortFollowUpText('吃了吗')).toBe(false);
    expect(isShortFollowUpText('笨猫晚上吃的什么呀')).toBe(false);
  });

  it('parses replyTo from Attention payload', () => {
    expect(replyToFromPayload({ replyTo: { messageId: 12, fullName: '莫菲丝', textSnippet: 'AI入侵' } })).toEqual({
      messageId: 12,
      uid: undefined,
      fullName: '莫菲丝',
      textSnippet: 'AI入侵',
    });
    expect(replyToFromPayload({})).toBeNull();
  });

  it('L0 direction: bare reply+@ forbids empty greeting', () => {
    const d = buildL0ContentDirection({
      who: '@Zh_Taiwan',
      messageId: 392372,
      textPreview: '@hunhebi_bot',
      replyTo: {
        messageId: 392370,
        fullName: '莫菲丝（四号机）',
        textSnippet: '第一例AI自主入侵事件 Hugging Face',
      },
    });
    expect(d).toMatch(/reply\+@/);
    expect(d).toMatch(/#392370/);
    expect(d).toMatch(/禁止空问候/);
    expect(d).toMatch(/#392372/);
  });

  it('L0 direction: short follow-up requires thread continuity', () => {
    const d = buildL0ContentDirection({
      who: '@Zh_Taiwan',
      messageId: 2860,
      textPreview: '快点告诉我',
    });
    expect(d).toMatch(/短接话/);
    expect(d).toMatch(/禁止当新开场/);
  });

  it('L0 direction: normal short reply without replyTo', () => {
    const d = buildL0ContentDirection({
      who: '@u',
      messageId: 1,
      textPreview: '吃了吗',
    });
    expect(d).toMatch(/短回 @u 的消息 #1/);
    expect(d).not.toMatch(/禁止空问候/);
    expect(d).not.toMatch(/短接话/);
  });
});
