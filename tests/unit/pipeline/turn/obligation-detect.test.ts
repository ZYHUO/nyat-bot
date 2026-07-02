import { describe, it, expect } from 'vitest';
import { detectReplyObligation, inferObligationKind } from '../../../../src/pipeline/turn/obligation-detect.ts';
import { selectActiveObligation } from '../../../../src/pipeline/turn/obligation-select.ts';
import type { FormattedMessage } from '../../../../src/shared/types.ts';

function msg(partial: Partial<FormattedMessage>): FormattedMessage {
  return {
    role: 'user',
    uid: 1,
    username: 'alice',
    fullName: 'Alice',
    timestamp: Date.now(),
    messageId: 1,
    textContent: '你好',
    isForwarded: false,
    ...partial,
  };
}

describe('obligation detection', () => {
  it('creates strong obligation for direct mention', () => {
    const obligation = detectReplyObligation({
      chatId: -100,
      message: msg({ textContent: '@xxb_bot 你怎么看' }),
      directKind: 'mention',
    });
    expect(obligation).not.toBeNull();
    expect(obligation?.mustReplyStrong).toBe(true);
    expect(obligation?.kind).toBe('mention');
  });

  it('creates direct_question obligation for explicit question even without direct marker', () => {
    expect(inferObligationKind(msg({ textContent: '这个怎么搞？' }), null)).toBe('direct_question');
  });

  it('does not create obligation for ambient statement', () => {
    const obligation = detectReplyObligation({
      chatId: -100,
      message: msg({ textContent: '今天天气不错' }),
      directKind: null,
    });
    expect(obligation).toBeNull();
  });
});

describe('obligation selection', () => {
  it('prefers strong/direct obligation over weaker one', () => {
    const weak = detectReplyObligation({
      chatId: -100,
      message: msg({ messageId: 10, textContent: '这个怎么搞？', uid: 10, fullName: 'A', username: 'a' }),
      directKind: null,
    })!;
    weak.priority = 60;
    weak.mustReplyStrong = false;

    const strong = detectReplyObligation({
      chatId: -100,
      message: msg({ messageId: 11, textContent: '@xxb_bot 帮我看下', uid: 20, fullName: 'B', username: 'b' }),
      directKind: 'mention',
    })!;

    const sel = selectActiveObligation([weak, strong]);
    expect(sel.active?.id).toBe(strong.id);
  });
});
