import { describe, expect, it } from 'vitest';
import { resolveReplyMode, buildReplyModeHint } from '../../../../src/pipeline/reply/reply-mode.js';
import type { FormattedMessage } from '../../../../src/shared/types.js';

function message(textContent: string): FormattedMessage {
  return {
    role: 'user', uid: 1, username: 'u', fullName: 'U', timestamp: 0, messageId: 1,
    textContent, isForwarded: false,
  };
}

describe('reply mode', () => {
  it('uses ack_then_expand for uncertain interesting claims', () => {
    const result = resolveReplyMode({ message: message('听说这个服务跑路了，真的假的'), action: 'REPLY' });
    expect(result.mode).toBe('ack_then_expand');
    expect(buildReplyModeHint(result, false)).toContain('2-12');
  });

  it('uses direct_answer for technical questions', () => {
    const result = resolveReplyMode({ message: message('这个接口报错怎么修复'), action: 'REPLY' });
    expect(result.mode).toBe('direct_answer');
    expect(buildReplyModeHint(result, false)).toContain('先给判断');
  });

  it('uses micro_reaction for short casual chatter', () => {
    const result = resolveReplyMode({ message: message('笑死'), action: 'REPLY' });
    expect(result.mode).toBe('micro_reaction');
  });

  it('does not choose a writing mode for ignored messages', () => {
    expect(resolveReplyMode({ message: message('随便'), action: 'IGNORE' }).mode).toBe('silent');
  });
});
