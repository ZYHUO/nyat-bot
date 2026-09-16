import { describe, it, expect } from 'vitest';

// H3 poll 进主流程：parser 必须认 poll action（TDD 红）
import { parseReplyResponse } from '../../../../src/pipeline/reply/parser.js';

describe('poll action (H3)', () => {
  it('parses poll action with question + options', () => {
    const raw = JSON.stringify([
      { action: 'poll', question: '今晚吃啥', options: ['火锅', '烧烤'], targetMessageId: 111 },
    ]);
    const parsed = parseReplyResponse(raw, 111);
    expect(parsed.length).toBe(1);
    expect(parsed[0]!.action).toBe('poll');
  });

  it('drops poll with empty question or <2 options', () => {
    const bad1 = JSON.stringify([{ action: 'poll', question: '', options: ['a', 'b'], targetMessageId: 1 }]);
    expect(parseReplyResponse(bad1, 1).filter((p) => p.action === 'poll').length).toBe(0);
    const bad2 = JSON.stringify([{ action: 'poll', question: '吃啥', options: ['就一个'], targetMessageId: 1 }]);
    expect(parseReplyResponse(bad2, 1).filter((p) => p.action === 'poll').length).toBe(0);
  });
});
