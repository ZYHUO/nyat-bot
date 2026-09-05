import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/env.js', () => ({
  env: () => ({
    AI_BASE_URL: 'https://openai.example/v1',
    AI_API_KEY: 'test-openai-key',
    AI_MODEL_JUDGE: 'judge-model',
    AI_MODEL_REPLY: 'reply-model',
    AI_MODEL_VISION: 'vision-model',
    AI_MODEL_SUMMARIZE: 'summarize-model',
    AI_MODEL_PATH_REFLECTION: 'path-reflection-model',
    AI_MODEL_REPLY_SPLITTER: 'reply-splitter-model',
    AI_MODEL_ALLOWLIST_REVIEW: 'allowlist-review-model',
    CLAUDE_BASE_URL: 'https://claude.example/v1',
    CLAUDE_API_KEY: 'test-claude-key',
    REPLY_BACKUP2_BASE_URL: undefined,
    REPLY_BACKUP2_API_KEY: undefined,
    REPLY_BACKUP2_MODEL: undefined,
    LOCAL_AI_BASE_URL: undefined,
    LOCAL_AI_API_KEY: undefined,
    LOCAL_AI_MODEL_JUDGE: undefined,
    LOCAL_AI_MODEL_SUMMARIZE: undefined,
    LOCAL_AI_MODEL_PATH_REFLECTION: undefined,
    LOCAL_AI_MODEL_ALLOWLIST: undefined,
  }),
  getProviders: () => new Map(),
  getUsageRouting: () => new Map(),
}));

import { _resetLabels, resolveUsageName } from '../../../src/ai/labels.js';

describe('labels', () => {
  beforeEach(() => {
    _resetLabels();
  });

  it('resolves legacy usage aliases to core departments', () => {
    expect(resolveUsageName('heart')).toBe('judge');
    expect(resolveUsageName('heart_reflect')).toBe('summarize');
    expect(resolveUsageName('path_reflection')).toBe('judge');
    expect(resolveUsageName('allowlist_review')).toBe('judge');
    expect(resolveUsageName('reply_splitter')).toBe('judge');
    expect(resolveUsageName('planner')).toBe('judge');
    expect(resolveUsageName('summarize_deep')).toBe('summarize');
    expect(resolveUsageName('reply')).toBe('reply');
  });
});

describe('usage-level jsonMode (H4.2)', () => {
  it('judge/summarize 硬默认含 jsonMode:true（fallback 透传，调用方可关）', async () => {
    // ensureUsageLabelsExist 要求 label 存在，mock 里 getProviders 为空调不动
    // getUsage —— 退化断言源码硬默认（getUsage 只是透传，fallback 侧 ?? 逻辑由类型保证）。
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('src/ai/labels.ts', 'utf-8');
    expect(src).toContain('jsonMode: true');
    const fb = readFileSync('src/ai/fallback.ts', 'utf-8');
    expect(fb).toContain('options.jsonMode ?? usage.jsonMode');
  });
});
