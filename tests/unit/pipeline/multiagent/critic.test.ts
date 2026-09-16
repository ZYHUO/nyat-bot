import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../../src/ai/fallback.js', () => ({ callWithFallback: vi.fn() }));
vi.mock('../../../../src/env.js', () => ({ env: () => ({ MULTI_AGENT_CRITIC_TIMEOUT_MS: 8000 }) }));
vi.mock('../../../../src/shared/logger.js', () => ({
  logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { runCritic } from '../../../../src/pipeline/multiagent/critic.js';
import { callWithFallback } from '../../../../src/ai/fallback.js';

const ok = (content: string) => ({ content, tokenUsage: { prompt: 1, completion: 1, total: 2 }, model: 'm', label: 'l', latencyMs: 1 });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('runCritic (parse verdict)', () => {
  it('{"ok":true} → needsRewrite false', async () => {
    (callWithFallback as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(ok('{"ok":true}'));
    expect(await runCritic({ messageText: 'q', draft: 'd' })).toEqual({ needsRewrite: false });
  });

  it('{"ok":false,"feedback":"..."} → needsRewrite true + feedback', async () => {
    (callWithFallback as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(ok('{"ok":false,"feedback":"跑题了,要回答天气"}'));
    const v = await runCritic({ messageText: 'q', draft: 'd' });
    expect(v.needsRewrite).toBe(true);
    expect(v.feedback).toContain('跑题');
  });

  it('带 ```json 围栏也能解析', async () => {
    (callWithFallback as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(ok('```json\n{"ok":false,"feedback":"语气不对"}\n```'));
    const v = await runCritic({ messageText: 'q', draft: 'd' });
    expect(v.needsRewrite).toBe(true);
    expect(v.feedback).toContain('语气不对');
  });

  it('非 JSON 但含"通过/ok" → needsRewrite false', async () => {
    (callWithFallback as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(ok('看起来没问题,ok'));
    expect(await runCritic({ messageText: 'q', draft: 'd' })).toEqual({ needsRewrite: false });
  });

  it('LLM 抛错 → fail-soft needsRewrite false(用原草稿)', async () => {
    (callWithFallback as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'));
    expect(await runCritic({ messageText: 'q', draft: 'd' })).toEqual({ needsRewrite: false });
  });
});
