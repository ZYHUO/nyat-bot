import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../../src/ai/fallback.js', () => ({ callWithFallback: vi.fn() }));
vi.mock('../../../../src/env.js', () => ({ env: () => ({ MULTI_AGENT_CONTEXT_DIGEST_TIMEOUT_MS: 8000, MULTI_AGENT_CONTEXT_DIGEST_MIN_MSGS: 12 }) }));
vi.mock('../../../../src/shared/logger.js', () => ({
  logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { runContextDigest } from '../../../../src/pipeline/multiagent/context-digest.js';
import { callWithFallback } from '../../../../src/ai/fallback.js';

const ok = (content: string) => ({ content, tokenUsage: { prompt: 1, completion: 1, total: 2 }, model: 'm', label: 'l', latencyMs: 1 });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('runContextDigest (上下文理解专家)', () => {
  it('消息数 < 阈值 → 不调 LLM,返回 null', async () => {
    expect(await runContextDigest({ context: 'x'.repeat(200), recentMsgCount: 5 })).toBeNull();
    expect(callWithFallback).not.toHaveBeenCalled();
  });

  it('上下文太短(<80)→ null', async () => {
    expect(await runContextDigest({ context: '短', recentMsgCount: 20 })).toBeNull();
  });

  it('够长 → 带 [现在在聊] 前缀', async () => {
    (callWithFallback as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(ok('两人在吵装机的显卡选型,气氛激烈'));
    const out = await runContextDigest({ context: 'x'.repeat(200), recentMsgCount: 20 });
    expect(out).toContain('[现在在聊]');
    expect(out).toContain('显卡');
  });

  it('LLM 抛错 → null', async () => {
    (callWithFallback as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'));
    expect(await runContextDigest({ context: 'x'.repeat(200), recentMsgCount: 20 })).toBeNull();
  });
});
