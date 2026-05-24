import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockCallWithFallback = vi.fn();
const mockLoadPrompt = vi.fn();
const mockGetConfig = vi.fn();

vi.mock('../../../src/ai/fallback.js', () => ({
  callWithFallback: (...args: unknown[]) => mockCallWithFallback(...args),
}));

vi.mock('../../../src/shared/config.js', () => ({
  loadPrompt: (...args: unknown[]) => mockLoadPrompt(...args),
  getConfig: (...args: unknown[]) => mockGetConfig(...args),
}));

import {
  parsePathReflectionResponse,
  reviewPathDecision,
} from '../../../src/pipeline/path-reflection.js';

describe('path reflection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadPrompt.mockReturnValue('# Path Reflection Task');
    mockGetConfig.mockReturnValue({ promptsDir: '/mock/prompts' });
    mockCallWithFallback.mockResolvedValue({
      content: JSON.stringify({
        shouldLearn: true,
        targetReplyPath: 'planned',
        pattern: 'market_quote',
        confidence: 0.91,
        reason: 'real-time market lookup request',
      }),
      tokenUsage: { prompt: 10, completion: 5, total: 15 },
      model: 'gpt-5.4',
      label: 'path_reflection',
      latencyMs: 20,
    });
  });

  it('parses structured reflection output', () => {
    const parsed = parsePathReflectionResponse(JSON.stringify({
      shouldLearn: true,
      targetReplyPath: 'planned',
      pattern: 'followup_lookup',
      confidence: 0.86,
      reason: 'follow-up to prior lookup',
    }));

    expect(parsed).toEqual({
      shouldLearn: true,
      targetReplyPath: 'planned',
      pattern: 'followup_lookup',
      confidence: 0.86,
      reason: 'follow-up to prior lookup',
    });
  });

  it('calls the dedicated path_reflection usage', async () => {
    const result = await reviewPathDecision({
      messageText: '有没有grok的股价',
      replyText: '主人，Grok 没有股票代码，它不是上市公司喵。',
      effectiveReplyPath: 'direct',
      matchedPatterns: ['market_quote'],
      toolsUsed: [],
      toolExecutionFailed: false,
    });

    expect(mockCallWithFallback).toHaveBeenCalledWith(expect.objectContaining({
      usage: 'path_reflection',
    }));
    expect(result.targetReplyPath).toBe('planned');
    expect(result.pattern).toBe('market_quote');
  });
});
