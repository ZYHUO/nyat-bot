import { describe, expect, it } from 'vitest';
import { modelStyleNudge } from '../../../../src/pipeline/reply/model-style.js';

describe('modelStyleNudge', () => {
  it('gemini 系命中极简补丁', () => {
    const n = modelStyleNudge('gemini-3.5-flash-low');
    expect(n).toBeDefined();
    expect(n).toContain('只出一条');
  });

  it('deepseek/v4 系命中禁前缀补丁', () => {
    for (const m of ['DeepSeek-V4-Pro', 'deepseek-v4-flash', 'dsv4pro']) {
      const n = modelStyleNudge(m);
      expect(n, m).toBeDefined();
      expect(n, m).toContain('绝不带任何前缀');
    }
  });

  it('grok / 未知模型无补丁', () => {
    expect(modelStyleNudge('grok-4.5')).toBeUndefined();
    expect(modelStyleNudge('gpt-5.5')).toBeUndefined();
    expect(modelStyleNudge(undefined)).toBeUndefined();
  });
});
