import { beforeEach, describe, expect, it, vi } from 'vitest';

const MOCK_PROVIDERS = new Map([
  ['reply_max_gpt54pro',    { name: 'reply_max_gpt54pro',    endpoint: 'https://openai.example/v1',  apiKey: 'test-openai-key',  model: 'gpt-5.4' }],
  ['reply_max_gemini31pro', { name: 'reply_max_gemini31pro', endpoint: 'https://gemini.example/v1', apiKey: 'test-gemini-key', model: 'gemini-3.1-pro' }],
  ['reply_max_opus',        { name: 'reply_max_opus',        endpoint: 'https://claude.example/v1', apiKey: 'test-claude-key', model: 'claude-opus-4' }],
]);

vi.mock('../../../src/env.js', () => ({
  env: () => ({
    AI_BASE_URL: 'https://openai.example/v1',
    AI_API_KEY: 'test-openai-key',
    AI_MODEL_JUDGE: 'judge-model',
    AI_MODEL_REPLY: 'reply-model',
    AI_MODEL_REPLY_PRO: 'reply-pro-model',
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
  getProviders: () => MOCK_PROVIDERS,
  getReplyMaxLabels: () => ['reply_max_gpt54pro', 'reply_max_gemini31pro', 'reply_max_opus'],
  getUsageRouting: () => new Map(),
}));

import { _resetLabels, getLabel, getUsage } from '../../../src/ai/labels.js';

describe('reply_max labels', () => {
  beforeEach(() => {
    _resetLabels();
  });

  it('uses the currently supported GPT model for reply_max openai leg', () => {
    expect(getLabel('reply_max_gpt54pro').model).toBe('gpt-5.4');
  });

  it('returns a three-model rotation for reply_max usage', () => {
    const usage = getUsage('reply_max');

    expect([
      'reply_max_gpt54pro',
      'reply_max_gemini31pro',
      'reply_max_opus',
    ]).toContain(usage.label);
    expect(usage.backups).toHaveLength(2);
    expect(new Set([usage.label, ...usage.backups]).size).toBe(3);
  });
});
