import { describe, expect, it } from 'vitest';
import { isEchoOf, normalizeEchoText } from '../../../src/shared/echo-text.js';

describe('echo-text', () => {
  it('detects exact and near-echo', () => {
    expect(isEchoOf('嫌贵别买', '嫌贵别买')).toBe(true);
    expect(isEchoOf('嫌贵别买喵', '嫌贵别买')).toBe(true);
    expect(isEchoOf('嫌贵别买。', '嫌贵别买')).toBe(true);
    expect(normalizeEchoText('嫌贵 别买！')).toBe('嫌贵别买');
  });

  it('allows real replies', () => {
    expect(isEchoOf('哼那你别买啊', '嫌贵别买')).toBe(false);
    expect(isEchoOf('好', '好的呢今天天气不错')).toBe(false);
  });
});
