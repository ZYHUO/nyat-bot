import { describe, expect, it } from 'vitest';
import {
  buildL0ContentDirection,
  filterAttentionForMetaLlm,
  formatAttentionReplyToBit,
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
    // ≤2 CJK content is NOT a ping (regression: 笨猫 → reply+@ dinner joke)
    expect(isBarePingText('笨猫')).toBe(false);
    expect(isBarePingText('早')).toBe(false);
    expect(isBarePingText('呢')).toBe(true);
    expect(isBarePingText('？')).toBe(true);
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
    // 中性方向（2026-08-19）：不再写死「短回」，闲聊/干活交给 executor 判断。
    expect(d).toMatch(/回应 @u 的消息 #1/);
    expect(d).not.toMatch(/短回 @u/);
    expect(d).not.toMatch(/禁止空问候/);
    expect(d).not.toMatch(/短接话/);
  });

  it('L0 direction: 「笨猫」with replyTo-self is content, not bare ping', () => {
    const d = buildL0ContentDirection({
      who: '@Zh_Taiwan',
      messageId: 393539,
      textPreview: '笨猫',
      replyTo: {
        messageId: 393535,
        uid: 1,
        textSnippet: '这晚饭吃完怕不是要被整条街的商家拉黑喵',
      },
      replyToIsSelf: true,
    });
    expect(d).toMatch(/回复你的 #393535/);
    expect(d).toMatch(/笨猫/);
    expect(d).not.toMatch(/reply\+@/);
    expect(d).not.toMatch(/禁止空问候/);
  });

  it('L0 direction: reply-to-self forbids invented「没事/本喵看着」', () => {
    const d = buildL0ContentDirection({
      who: '@Zh_Taiwan',
      messageId: 393495,
      textPreview: '千雪怎么了',
      replyTo: {
        messageId: 393494,
        uid: 1,
        textSnippet: '哼 本喵刚醒 才没跟他玩',
      },
      replyToIsSelf: true,
      masterHint: '对方是主人(@Zh_Taiwan)：软一点、听话一点。',
    });
    expect(d).toMatch(/回复你的 #393494/);
    expect(d).toMatch(/千雪怎么了/);
    expect(d).toMatch(/禁止臆造/);
    expect(d).toMatch(/没事\/本喵看着/);
    expect(d).not.toMatch(/简单说没事/);
  });

  it('formats replyTo bit for Meta Attention lines', () => {
    expect(
      formatAttentionReplyToBit({
        replyTo: { messageId: 393494, fullName: '啾咪囝', textSnippet: '哼 本喵刚醒 才没跟他玩' },
      }),
    ).toMatch(/replyTo=#393494 啾咪囝「哼 本喵刚醒/);
    expect(formatAttentionReplyToBit({})).toBe('');
  });

  it('filters already-dispatched chats out of Meta LLM Attention', () => {
    const items = [
      { chatId: 1, layer: 'L0' },
      { chatId: 2, layer: 'L1' },
      { chatId: 1, layer: 'L2' },
    ];
    expect(filterAttentionForMetaLlm(items, new Set([1]))).toEqual([{ chatId: 2, layer: 'L1' }]);
    expect(filterAttentionForMetaLlm(items, new Set())).toEqual(items);
  });
});
