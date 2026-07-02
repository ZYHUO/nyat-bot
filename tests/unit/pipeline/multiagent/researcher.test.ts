import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../../src/pipeline/planner/agentic-loop.js', () => ({
  runAgenticPlanner: vi.fn(),
}));
vi.mock('../../../../src/env.js', () => ({
  env: () => ({ MULTI_AGENT_RESEARCHER_TIMEOUT_MS: 20000, MULTI_AGENT_RESEARCHER_MAX_STEPS: 4 }),
}));

import { runResearcher } from '../../../../src/pipeline/multiagent/researcher.js';
import { runAgenticPlanner } from '../../../../src/pipeline/planner/agentic-loop.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('runResearcher (SEARCH/FETCH 子集 + 超时合并 + M2 maxStepsOverride)', () => {
  it('透传 toolFilter=[SEARCH,FETCH] + maxStepsOverride + 合并后的 signal', async () => {
    (runAgenticPlanner as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      failed: false, toolResultsBlock: '[TOOL_RESULTS]\nx', toolsUsed: ['SEARCH'], steps: 1,
    });
    await runResearcher({ messageText: '今天天气', context: 'CTX', chatId: -1, userId: 2 });
    const arg = (runAgenticPlanner as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      toolFilter: string[]; maxStepsOverride: number; messageText: string; context: string; signal?: AbortSignal;
    };
    expect(arg.toolFilter).toEqual(['SEARCH', 'FETCH']);
    expect(arg.maxStepsOverride).toBe(4); // M2:研究员自定预算,不再用 PLANNER_MAX_STEPS
    expect(arg.messageText).toBe('今天天气');
    expect(arg.context).toBe('CTX');
    expect(arg.signal).toBeTruthy();
    expect(arg.signal?.aborted).toBe(false);
  });

  it('turnSignal 与超时合并 → signal 仍可被外部 abort', async () => {
    (runAgenticPlanner as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      failed: false, toolResultsBlock: 'x', toolsUsed: [], steps: 0,
    });
    const ac = new AbortController();
    await runResearcher({ messageText: 'q', context: 'c', chatId: -1, userId: 2, turnSignal: ac.signal });
    const arg = (runAgenticPlanner as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { signal?: AbortSignal };
    expect(arg.signal).toBeTruthy();
    ac.abort();
    expect(arg.signal?.aborted).toBe(true);
  });

  it('knowledge 透传给 agentic loop(L4:研究员看到本地 KB)', async () => {
    (runAgenticPlanner as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      failed: false, toolResultsBlock: 'x', toolsUsed: [], steps: 0,
    });
    await runResearcher({ messageText: 'q', context: 'c', knowledge: 'KB_SNIPPET', chatId: -1, userId: 2 });
    const arg = (runAgenticPlanner as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { knowledge?: string };
    expect(arg.knowledge).toBe('KB_SNIPPET');
  });
});
