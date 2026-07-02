import { describe, it, expect } from 'vitest';
import { createReplyObligation } from '../../../../src/pipeline/turn/obligation.ts';
import { deriveTopicKey, isObligationCancelMessage } from '../../../../src/pipeline/turn/obligation-detect.ts';

describe('obligation topic/cancel helpers', () => {
  it('derives stable topic key from reply/thread-aware text', () => {
    const key = deriveTopicKey({ role: 'user', uid: 1, username: 'a', fullName: 'A', timestamp: 0, messageId: 1, textContent: '@xxb_bot 这个怎么修', isForwarded: false, replyTo: { messageId: 99, uid: 2, fullName: 'B', textSnippet: 'x' } });
    expect(key).toContain('r99:');
  });

  it('detects explicit cancellation from same target user', () => {
    const active = createReplyObligation({
      chatId: -100,
      message: { role: 'user', uid: 1, username: 'a', fullName: 'A', timestamp: 0, messageId: 1, textContent: '@xxb_bot 帮我看看', isForwarded: false },
      kind: 'mention',
      directInteraction: true,
      mustReplyStrong: true,
    });
    const cancel = { role: 'user', uid: 1, username: 'a', fullName: 'A', timestamp: 0, messageId: 2, textContent: '算了不用回了', isForwarded: false };
    expect(isObligationCancelMessage(cancel, active)).toBe(true);
  });

  it('does not cancel unrelated topic from same user without reply/topic match', () => {
    const active = createReplyObligation({
      chatId: -100,
      message: { role: 'user', uid: 1, username: 'a', fullName: 'A', timestamp: 0, messageId: 1, textContent: '@xxb_bot 帮我看看这个报错怎么修', isForwarded: false },
      kind: 'mention',
      directInteraction: true,
      mustReplyStrong: true,
      topicKey: '这个报错怎么修',
    });
    const cancel = { role: 'user', uid: 1, username: 'a', fullName: 'A', timestamp: 0, messageId: 2, textContent: '算了，今晚不打游戏了', isForwarded: false };
    expect(isObligationCancelMessage(cancel, active)).toBe(false);
  });

  it('cancels when replying to the original obligation anchor', () => {
    const active = createReplyObligation({
      chatId: -100,
      message: { role: 'user', uid: 1, username: 'a', fullName: 'A', timestamp: 0, messageId: 9, textContent: '@xxb_bot 帮我看看', isForwarded: false },
      kind: 'mention',
      directInteraction: true,
      mustReplyStrong: true,
    });
    const cancel = {
      role: 'user' as const,
      uid: 2,
      username: 'b',
      fullName: 'B',
      timestamp: 0,
      messageId: 10,
      textContent: '算了不用回了',
      isForwarded: false,
      replyTo: { messageId: 9, uid: 1, fullName: 'A', textSnippet: '帮我看看' },
    };
    expect(isObligationCancelMessage(cancel, active)).toBe(true);
  });
});
