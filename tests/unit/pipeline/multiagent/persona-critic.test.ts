import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../../src/ai/fallback.js', () => ({ callWithFallback: vi.fn() }));
vi.mock('../../../../src/env.js', () => ({ env: () => ({ MULTI_AGENT_PERSONA_CRITIC_TIMEOUT_MS: 6000 }) }));
vi.mock('../../../../src/shared/logger.js', () => ({
  logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { runPersonaCritic } from '../../../../src/pipeline/multiagent/persona-critic.js';
import { callWithFallback } from '../../../../src/ai/fallback.js';

const ok = (content: string) => ({ content, tokenUsage: { prompt: 1, completion: 1, total: 2 }, model: 'm', label: 'l', latencyMs: 1 });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('runPersonaCritic (人设/关系一致性)', () => {
  it('{"ok":true} → needsRewrite false', async () => {
    (callWithFallback as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(ok('{"ok":true}'));
    expect(await runPersonaCritic({ messageText: 'q', draft: 'd' })).toEqual({ needsRewrite: false });
  });

  it('把主人叫成妹妹 → needsRewrite true + feedback', async () => {
    (callWithFallback as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(ok('{"ok":false,"feedback":"把主人叫成妹妹了,改成主人"}'));
    const v = await runPersonaCritic({ messageText: 'q', draft: '好的妹妹' });
    expect(v.needsRewrite).toBe(true);
    expect(v.feedback).toContain('主人');
  });

  it('带 ```json 围栏也能解析', async () => {
    (callWithFallback as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(ok('```json\n{"ok":false,"feedback":"语气不对"}\n```'));
    const v = await runPersonaCritic({ messageText: 'q', draft: 'd' });
    expect(v.needsRewrite).toBe(true);
    expect(v.feedback).toContain('语气');
  });

  it('非 JSON 含"通过/ok" → needsRewrite false', async () => {
    (callWithFallback as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(ok('人设没问题,ok'));
    expect(await runPersonaCritic({ messageText: 'q', draft: 'd' })).toEqual({ needsRewrite: false });
  });

  it('LLM 抛错 → fail-soft needsRewrite false', async () => {
    (callWithFallback as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'));
    expect(await runPersonaCritic({ messageText: 'q', draft: 'd' })).toEqual({ needsRewrite: false });
  });
});
