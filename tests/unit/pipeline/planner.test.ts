import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockCallWithFallback = vi.fn();
const mockLoadPrompt = vi.fn();
const mockGetConfig = vi.fn();
const mockBuildToolSet = vi.fn();

vi.mock('../../../src/ai/fallback.js', () => ({
  callWithFallback: (...args: unknown[]) => mockCallWithFallback(...args),
}));

vi.mock('../../../src/shared/config.js', () => ({
  loadPrompt: (...args: unknown[]) => mockLoadPrompt(...args),
  getConfig: (...args: unknown[]) => mockGetConfig(...args),
}));

vi.mock('../../../src/pipeline/tools/registry.js', () => ({
  buildToolSet: (...args: unknown[]) => mockBuildToolSet(...args),
  getToolNames: vi.fn(() => []),
  preloadSkills: vi.fn(),
  executeValidatedToolStep: async (
    toolName: string,
    rawArgs: unknown,
    chatId: number,
    userId: number,
  ) => {
    const tools = mockBuildToolSet(chatId, userId) as Record<
      string,
      { execute?: (a: unknown, b: unknown) => Promise<unknown> }
    >;
    const t = tools[toolName];
    if (!t?.execute) throw new Error(`no tool ${toolName}`);
    return t.execute(rawArgs, { toolCallId: 'planner', messages: [] });
  },
}));

import { parsePlannerResponse, planReply } from '../../../src/pipeline/planner/planner.js';
import { executeToolPlan, formatToolResultsForPrompt } from '../../../src/pipeline/planner/executor.js';

describe('planner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadPrompt.mockReturnValue('# Planner Task');
    mockGetConfig.mockReturnValue({ promptsDir: '/mock/prompts' });
    mockCallWithFallback.mockResolvedValue({
      content: JSON.stringify({
        needTools: true,
        answerStrategy: 'tool_then_answer',
        steps: [{ tool: 'SEARCH', args: { query: 'latest news' }, purpose: 'fetch facts' }],
      }),
      tokenUsage: { prompt: 10, completion: 5, total: 15 },
      model: 'reply-pro',
      label: 'reply_pro',
      latencyMs: 20,
    });
    mockBuildToolSet.mockReturnValue({
      SEARCH: {
        execute: vi.fn(
          async ({ query }: { query: string }, _opts: unknown) => ({ query, result: 'ok' }),
        ),
      },
    });
  });

  it('parses planner output with ordered steps', () => {
    const plan = parsePlannerResponse(JSON.stringify({
      needTools: true,
      answerStrategy: 'tool_then_answer',
      steps: [
        { tool: 'SEARCH', args: { query: 'q1' }, purpose: 'find facts' },
        { tool: 'FETCH', args: { url: 'https://example.com' }, purpose: 'read page' },
      ],
    }));

    expect(plan).toEqual({
      needTools: true,
      answerStrategy: 'tool_then_answer',
      steps: [
        { tool: 'SEARCH', args: { query: 'q1' }, purpose: 'find facts' },
        { tool: 'FETCH', args: { url: 'https://example.com' }, purpose: 'read page' },
      ],
    });
  });

  it('maps planner AI output into a typed plan', async () => {
    const plan = await planReply({
      usage: 'reply_pro',
      messageText: '帮我查最新新闻',
      context: 'recent context',
      availableTools: ['SEARCH', 'FETCH'],
    });

    expect(mockCallWithFallback).toHaveBeenCalledTimes(1);
    expect(mockCallWithFallback).toHaveBeenCalledWith(expect.objectContaining({
      messages: expect.arrayContaining([
        expect.objectContaining({
          role: 'user',
          content: expect.stringContaining('[AVAILABLE_TOOLS]\nSEARCH\nFETCH'),
        }),
      ]),
    }));
    expect(plan).toEqual({
      needTools: true,
      answerStrategy: 'tool_then_answer',
      steps: [{ tool: 'SEARCH', args: { query: 'latest news' }, purpose: 'fetch facts' }],
    });
  });

  it('executes only planner-selected tools in order', async () => {
    const executed = await executeToolPlan(
      {
        needTools: true,
        answerStrategy: 'tool_then_answer',
        steps: [{ tool: 'SEARCH', args: { query: 'latest news' }, purpose: 'fetch facts' }],
      },
      { chatId: 1, userId: 2 },
    );

    expect(mockBuildToolSet).toHaveBeenCalledWith(1, 2);
    expect(executed).toEqual([
      {
        tool: 'SEARCH',
        args: { query: 'latest news' },
        purpose: 'fetch facts',
        output: { query: 'latest news', result: 'ok' },
      },
    ]);
  });

  it('formats tool results into a prompt block', () => {
    const promptBlock = formatToolResultsForPrompt([
      {
        tool: 'SEARCH',
        args: { query: 'latest news' },
        purpose: 'fetch facts',
        output: { title: 'headline' },
      },
    ]);

    expect(promptBlock).toContain('[TOOL_RESULTS]');
    expect(promptBlock).toContain('SEARCH');
    expect(promptBlock).toContain('headline');
  });
});
