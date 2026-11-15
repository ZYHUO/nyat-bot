import { describe, expect, it } from 'vitest';
import { createQQBubbleBudget, planQQTextBubbles, resolveQQReplyAnchor } from '../../../src/subagent/qq-delivery-policy.js';

describe('QQ concise text delivery policy', () => {
  it('preserves short text and complete natural two-bubble replies', () => {
    expect(planQQTextBubbles('这个思路可以继续')).toEqual(['这个思路可以继续']);
    expect(planQQTextBubbles('先保留这个方案。下一步补上边界测试。')).toEqual(['先保留这个方案。下一步补上边界测试。']);
    expect(planQQTextBubbles('（只是补充）这部分已经好了\n接下来验证结果')).toEqual(['（只是补充）这部分已经好了', '接下来验证结果']);
    expect(planQQTextBubbles('第一点。第二点。第三点。第四点。')).toHaveLength(1);
    expect(planQQTextBubbles('第一点。\n\n第二点。')).toEqual(['第一点。', '第二点。']);
  });
  it('never corrupts URLs, fenced code, emoji or punctuation', () => {
    for (const text of ['看 https://example.com/?q=a!b;c', '```js\nconst ok = true;\n```', '🙂'.repeat(120)]) {
      expect(planQQTextBubbles(text)).toEqual([text]);
    }
    const text = '甲'.repeat(100) + '。' + '乙'.repeat(100) + '！';
    expect(planQQTextBubbles(text)).toHaveLength(2);
    expect(planQQTextBubbles(text).join('')).toBe(text);
  });
  it('rejects overflow before sending instead of dropping content or creating unlimited bubbles', () => {
    for (const text of ['甲'.repeat(121), '🙂'.repeat(241), '句。'.repeat(121)]) {
      expect(() => planQQTextBubbles(text)).toThrow('压缩完整回答');
    }
  });
  it('requires explicit scoped reply IDs; omission is truly unquoted', () => {
    expect(resolveQQReplyAnchor(undefined, [101])).toBeUndefined();
    expect(resolveQQReplyAnchor(null, [101])).toBeUndefined();
    expect(resolveQQReplyAnchor(101, [101])).toBe(101);
    for (const value of [0, -1, 102, '101', 101.5, Number.NaN]) {
      expect(() => resolveQQReplyAnchor(value, [101])).toThrow('引用只能选择本任务');
    }
    expect(() => resolveQQReplyAnchor(101, [])).toThrow();
  });
  it('reserves whole replies against concurrent callers, charges ACKs and releases only unsent bubbles', () => {
    const budget = createQQBubbleBudget(3);
    const first = budget.reserve(2);
    expect(() => budget.reserve(2)).toThrow('sendText_limit:3');
    first.acknowledge(); first.release(); first.release();
    const second = budget.reserve(2);
    second.acknowledge(); second.acknowledge(); second.release();
    expect(() => budget.reserve(1)).toThrow('sendText_limit:3');
    expect(() => second.acknowledge()).toThrow('receipt_without_reservation');
  });
});
