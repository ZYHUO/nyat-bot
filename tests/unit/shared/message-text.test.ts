import { describe, expect, it } from 'vitest';
import {
  looksLikePromptEnvelope,
  sanitizeContentDirection,
  unwrapPromptEnvelope,
} from '../../../src/shared/message-text.js';

describe('message-text envelope', () => {
  const envelope =
    '用户Qingu LiLi{id: 5526418611}发送了 \n{啾咪猫猫，给我留点小鱼干吧喵？}，考虑回复{ID392281}的对话。';

  it('detects and unwraps MaiBot-style envelopes', () => {
    expect(looksLikePromptEnvelope(envelope)).toBe(true);
    expect(unwrapPromptEnvelope(envelope)).toBe('啾咪猫猫，给我留点小鱼干吧喵？');
  });

  it('sanitizes contentDirection that embeds the envelope', () => {
    const d = sanitizeContentDirection(envelope, 392287);
    expect(d).toContain('#392287');
    expect(d).toContain('小鱼干');
    expect(d).not.toMatch(/考虑回复\{ID/);
    expect(d).toContain('禁止复读');
  });

  it('leaves normal short directions mostly intact', () => {
    const d = sanitizeContentDirection('短回摸头', 12);
    expect(d).toContain('短回摸头');
    expect(d).toContain('#12');
  });
});
