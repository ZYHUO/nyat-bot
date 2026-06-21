import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCall = vi.fn();
const mockBuildSystem = vi.fn(() => 'STATIC_SYSTEM_PREFIX');
const mockIsAsleep = vi.fn();
let warmupEnabled = true;

vi.mock('../../../src/env.js', () => ({ env: () => ({ CACHE_WARMUP_ENABLED: warmupEnabled }) }));
vi.mock('../../../src/ai/fallback.js', () => ({ callWithFallback: (...a: unknown[]) => mockCall(...a) }));
vi.mock('../../../src/pipeline/reply/prompt-builder.js', () => ({ buildSystemPrompt: (...a: unknown[]) => mockBuildSystem(...a) }));
vi.mock('../../../src/tracking/sleep.js', () => ({ isAsleep: (...a: unknown[]) => mockIsAsleep(...a) }));

import { runCacheWarmup } from '../../../src/cron/cache-warmup.js';

describe('cache-warmup', () => {
  beforeEach(() => { vi.clearAllMocks(); warmupEnabled = true; mockIsAsleep.mockResolvedValue(false); mockCall.mockResolvedValue({ content: 'ok' }); });

  it('pings with the static normal-tier system prefix and suppresses metrics', async () => {
    await runCacheWarmup();
    expect(mockBuildSystem).toHaveBeenCalledWith('normal');
    expect(mockCall).toHaveBeenCalledTimes(1);
    const arg = mockCall.mock.calls[0]![0] as { usage: string; messages: Array<{ role: string; content: string }>; suppressMetrics: boolean; maxTokens: number };
    expect(arg.usage).toBe('reply');
    expect(arg.suppressMetrics).toBe(true);
    expect(arg.messages[0]).toEqual({ role: 'system', content: 'STATIC_SYSTEM_PREFIX' });
    expect(arg.maxTokens).toBeLessThanOrEqual(16);
  });

  it('skips when the flag is off', async () => {
    warmupEnabled = false;
    await runCacheWarmup();
    expect(mockCall).not.toHaveBeenCalled();
  });

  it('skips while asleep', async () => {
    mockIsAsleep.mockResolvedValue(true);
    await runCacheWarmup();
    expect(mockCall).not.toHaveBeenCalled();
  });

  it('never throws even if the LLM call fails', async () => {
    mockCall.mockRejectedValue(new Error('boom'));
    await expect(runCacheWarmup()).resolves.toBeUndefined();
  });
});
