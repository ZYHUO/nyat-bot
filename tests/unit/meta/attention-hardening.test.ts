import { describe, expect, it } from 'vitest';
import { softTruncate } from '../../../src/shared/soft-truncate.js';
import { classifyAttentionLayer } from '../../../src/meta/classify-layer.js';

describe('softTruncate', () => {
  it('does not cut mid-CJK sentence when punctuation is nearby', () => {
    const s = '本喵觉得这样不行啦，你怎么还在说这种话啊啊啊啊啊啊啊啊';
    const out = softTruncate(s, 20);
    expect(out.length).toBeLessThanOrEqual(20);
    expect(out.includes('，') || out.endsWith('啦') || !/[啊]{3}$/.test(out)).toBe(true);
  });

  it('returns unchanged when short enough', () => {
    expect(softTruncate('短', 10)).toBe('短');
  });
});

describe('classifyAttentionLayer', () => {
  it('DM and direct → L0', () => {
    expect(classifyAttentionLayer({ chatId: 1, isDirect: false, text: 'hi' }).layer).toBe('L0');
    expect(
      classifyAttentionLayer({ chatId: -1, isDirect: true, directKind: 'mention', text: 'x' }).layer,
    ).toBe('L0');
  });

  it('passive question → L2 (Heart LLM decides; no regex layer guessing)', () => {
    // 纯 LLM 驱动 (2026-08-06)：L1 正则问题检测已删除，被动消息一律 L2，
    // 由 Heart LLM 决定是否插话。
    const d = classifyAttentionLayer({ chatId: -100, isDirect: false, text: '这是什么意思？' });
    expect(d.layer).toBe('L2');
    expect(d.reason).toBe('passive');
  });

  it('casual 吗-chatter stays L2', () => {
    expect(
      classifyAttentionLayer({ chatId: -100, isDirect: false, text: '好可爱吗' }).layer,
    ).toBe('L2');
  });

  it('passive chatter → L2', () => {
    expect(
      classifyAttentionLayer({ chatId: -100, isDirect: false, text: '哈哈哈哈' }).layer,
    ).toBe('L2');
  });
});
