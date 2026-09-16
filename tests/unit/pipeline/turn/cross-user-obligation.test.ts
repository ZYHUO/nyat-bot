import { describe, it, expect } from 'vitest';
import { createReplyObligation } from '../../../../src/pipeline/turn/obligation.ts';
import { selectActiveObligation } from '../../../../src/pipeline/turn/obligation-select.ts';

function makeObligation(args: {
  uid: number;
  messageId: number;
  text: string;
  kind: 'mention' | 'direct_question' | 'judge_reply';
  strong: boolean;
  createdAt: number;
}) {
  const o = createReplyObligation({
    chatId: -100,
    message: {
      role: 'user',
      uid: args.uid,
      username: `u${args.uid}`,
      fullName: `U${args.uid}`,
      timestamp: args.createdAt,
      messageId: args.messageId,
      textContent: args.text,
      isForwarded: false,
    },
    kind: args.kind,
    directInteraction: args.strong,
    mustReplyStrong: args.strong,
  });
  o.createdAt = args.createdAt;
  o.updatedAt = args.createdAt;
  if (!args.strong) o.priority = 50;
  return o;
}

describe('cross-user obligation priority', () => {
  it('keeps earlier strong obligation ahead of later ambient/inferred one', () => {
    const strong = makeObligation({ uid: 1, messageId: 10, text: '@xxb_bot 这个怎么修', kind: 'mention', strong: true, createdAt: 100 });
    const ambient = makeObligation({ uid: 2, messageId: 11, text: '今天天气不错', kind: 'judge_reply', strong: false, createdAt: 200 });
    const selected = selectActiveObligation([strong, ambient]).active;
    expect(selected?.id).toBe(strong.id);
  });

  it('allows stronger later direct obligation to supersede earlier strong one', () => {
    const first = makeObligation({ uid: 1, messageId: 10, text: '@xxb_bot 帮我看看', kind: 'mention', strong: true, createdAt: 100 });
    const later = makeObligation({ uid: 2, messageId: 11, text: '@xxb_bot 现在回答我', kind: 'mention', strong: true, createdAt: 200 });
    later.priority = 101;
    const selected = selectActiveObligation([first, later]).active;
    expect(selected?.id).toBe(later.id);
  });
});
