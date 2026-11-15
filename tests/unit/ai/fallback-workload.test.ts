import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AICallResult } from '../../../src/ai/types.js';

const state = vi.hoisted(() => ({
  provider: vi.fn(), acquire: vi.fn(), incr: vi.fn(), decr: vi.fn(), counter: vi.fn(),
  releases: [] as ReturnType<typeof vi.fn>[],
  config: { AI_WORKLOAD_BUDGET_ENABLED: true, AI_MAX_INFLIGHT_PER_MODEL: 2,
    AI_MAX_BACKGROUND_INFLIGHT_PER_MODEL: 1, HEDGE_DELAY_MS: 0 },
  usage: { label: 'primary', backups: [] as string[], timeout: 60_000 },
  labelTimeout: undefined as number | undefined,
}));

vi.mock('../../../src/ai/provider.js', () => ({ callModel: state.provider }));
vi.mock('../../../src/ai/labels.js', () => ({
  getUsage: () => state.usage,
  getLabel: (name: string) => ({ name, model: 'shared-model', endpoint: 'http://unused.test',
    apiKeys: ['test'], timeout: state.labelTimeout }),
}));
vi.mock('../../../src/ai/workload.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/ai/workload.js')>(), acquireAiLease: state.acquire,
}));
vi.mock('../../../src/ai/smart-group.js', () => ({
  isAutoAssignEnabled: () => false, smartGroupAutoAssign: async () => [],
  smartGroupReorder: async (names: string[]) => names, recordSmartGroupResult: async () => {},
}));
vi.mock('../../../src/ai/cooldown.js', () => ({
  CooldownTracker: class {
    isCoolingDown = async () => false;
    getRemainingSeconds = async () => 0;
    recordSuccess = async () => {};
    recordFailure = async () => false;
    setCooldown = async () => {};
  },
}));
vi.mock('../../../src/db/redis.js', () => ({
  getRedis: () => ({ incr: state.incr, decr: state.decr, expire: async () => 1 }),
}));
vi.mock('../../../src/env.js', () => ({ env: () => state.config }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../src/metrics/registry.js', () => ({ incrCounter: state.counter }));
vi.mock('../../../src/ai/events.js', () => ({ emitLlmResult: vi.fn(), emitLlmError: vi.fn() }));

import { callWithFallback } from '../../../src/ai/fallback.js';
import { runWithAiWorkload } from '../../../src/ai/workload.js';

const base = { usage: 'reply', messages: [{ role: 'user' as const, content: 'test' }] };
const result = (label = 'primary'): AICallResult => ({
  label, model: 'shared-model', content: 'ok', latencyMs: 1,
  tokenUsage: { prompt: 1, completion: 1, total: 2 },
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function permit() {
  const release = vi.fn(async () => {});
  state.releases.push(release);
  return { release };
}

beforeEach(() => {
  vi.useFakeTimers();
  state.provider.mockReset().mockResolvedValue(result());
  state.acquire.mockReset().mockImplementation(async () => permit());
  state.incr.mockReset().mockResolvedValue(1);
  state.decr.mockReset().mockResolvedValue(0);
  state.counter.mockClear();
  state.releases.length = 0;
  state.config.AI_WORKLOAD_BUDGET_ENABLED = true;
  state.config.HEDGE_DELAY_MS = 0;
  state.usage.backups = [];
  state.usage.timeout = 60_000;
  state.labelTimeout = undefined;
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('fallback workload lease integration', () => {
  it('passes background context and leaves concurrent foreground interactive', async () => {
    const pending = deferred<AICallResult>();
    state.provider.mockImplementationOnce(() => pending.promise);
    const background = runWithAiWorkload('background', () => callWithFallback(base));
    await vi.advanceTimersByTimeAsync(0);
    await callWithFallback(base);
    expect(state.acquire.mock.calls.map(call => call[1].workload)).toEqual(['background', 'interactive']);
    expect(state.acquire.mock.calls[0]![1]).toMatchObject({ totalLimit: 2, backgroundLimit: 1 });
    expect(state.releases[0]).not.toHaveBeenCalled();
    pending.resolve(result());
    await background;
    expect(state.releases[0]).toHaveBeenCalledTimes(1);
  });

  it('uses the effective per-label timeout and honors caller caps', async () => {
    state.labelTimeout = 600_000;
    await callWithFallback(base);
    await callWithFallback({ ...base, maxTimeoutMs: 5000 });
    expect(state.acquire.mock.calls.map(call => call[1].timeoutMs)).toEqual([600_000, 5000]);
    expect(state.provider.mock.calls.map(call => call[2].timeout)).toEqual([600_000, 5000]);
  });

  it('keeps the legacy admission path when disabled', async () => {
    state.config.AI_WORKLOAD_BUDGET_ENABLED = false;
    await runWithAiWorkload('background', () => callWithFallback(base));
    expect(state.acquire).not.toHaveBeenCalled();
    expect(state.incr).toHaveBeenCalledWith('xxb:ai:inflight:shared-model');
    expect(state.decr).toHaveBeenCalledTimes(1);
  });

  it('does not start a provider if the enabled lease backend fails', async () => {
    state.acquire.mockRejectedValue(new Error('Redis unavailable'));
    await expect(callWithFallback(base)).rejects.toThrow('All labels exhausted');
    expect(state.provider).not.toHaveBeenCalled();
    expect(state.counter).toHaveBeenCalledWith('llm_workload_admission_error_total',
      { model: 'shared-model', workload: 'interactive' });
  });

  it('releases failed and successful sequential attempts exactly once', async () => {
    state.usage.backups = ['backup'];
    state.provider.mockRejectedValueOnce(new Error('primary failed')).mockResolvedValueOnce(result('backup'));
    expect((await callWithFallback(base)).label).toBe('backup');
    expect(state.releases).toHaveLength(2);
    for (const release of state.releases) expect(release).toHaveBeenCalledTimes(1);
  });

  it('waits for a successful primary when the hedge has no slot', async () => {
    state.usage.backups = ['hedge'];
    state.config.HEDGE_DELAY_MS = 5;
    const pending = deferred<AICallResult>();
    state.provider.mockImplementationOnce(() => pending.promise);
    state.acquire.mockImplementationOnce(async () => permit()).mockResolvedValueOnce(null);
    const call = callWithFallback(base);
    await vi.advanceTimersByTimeAsync(10);
    expect(state.provider).toHaveBeenCalledTimes(1);
    expect(state.releases[0]).not.toHaveBeenCalled();
    pending.resolve(result());
    expect((await call).label).toBe('primary');
    expect(state.releases[0]).toHaveBeenCalledTimes(1);
  });

  it('does not reserve a hedge slot before the delay', async () => {
    state.usage.backups = ['hedge'];
    state.config.HEDGE_DELAY_MS = 100;
    const call = callWithFallback(base);
    await vi.advanceTimersByTimeAsync(0);
    await call;
    await vi.advanceTimersByTimeAsync(200);
    expect(state.acquire).toHaveBeenCalledTimes(1);
    expect(state.provider).toHaveBeenCalledTimes(1);
  });

  it('releases both leases when both hedge branches fail', async () => {
    state.usage.backups = ['hedge'];
    state.config.HEDGE_DELAY_MS = 5;
    state.provider.mockRejectedValue(new Error('provider failed'));
    const outcome = callWithFallback(base).catch(err => err as Error);
    await vi.advanceTimersByTimeAsync(10);
    expect(await outcome).toBeInstanceOf(Error);
    expect(state.releases).toHaveLength(2);
    for (const release of state.releases) expect(release).toHaveBeenCalledTimes(1);
  });

  it('holds the losing lease until that provider actually settles after abort', async () => {
    state.usage.backups = ['hedge'];
    state.config.HEDGE_DELAY_MS = 5;
    const loser = deferred<AICallResult>();
    state.provider.mockImplementation((label: { name: string }) => label.name === 'primary'
      ? loser.promise : Promise.resolve(result('hedge')));
    const call = callWithFallback(base);
    await vi.advanceTimersByTimeAsync(10);
    expect((await call).label).toBe('hedge');
    expect(state.provider.mock.calls[0]![2].signal.aborted).toBe(true);
    expect(state.releases[0]).not.toHaveBeenCalled();
    expect(state.releases[1]).toHaveBeenCalledTimes(1);
    loser.resolve(result());
    await vi.advanceTimersByTimeAsync(0);
    expect(state.releases[0]).toHaveBeenCalledTimes(1);
  });

  it('releases a delayed hedge admission if the primary has already won', async () => {
    state.usage.backups = ['hedge'];
    state.config.HEDGE_DELAY_MS = 5;
    const primary = deferred<AICallResult>();
    const admission = deferred<ReturnType<typeof permit>>();
    state.provider.mockImplementationOnce(() => primary.promise);
    state.acquire.mockImplementationOnce(async () => permit()).mockImplementationOnce(() => admission.promise);
    const call = callWithFallback(base);
    await vi.advanceTimersByTimeAsync(10);
    primary.resolve(result());
    await call;
    admission.resolve(permit());
    await vi.advanceTimersByTimeAsync(0);
    expect(state.provider).toHaveBeenCalledTimes(1);
    expect(state.releases[1]).toHaveBeenCalledTimes(1);
  });

  it('retains background classification during the bounded in-flight retry', async () => {
    state.acquire.mockResolvedValueOnce(null).mockImplementationOnce(async () => permit());
    const call = runWithAiWorkload('background', () => callWithFallback({ ...base, waitIfCooling: true }));
    await vi.advanceTimersByTimeAsync(3100);
    await call;
    expect(state.acquire.mock.calls.map(args => args[1].workload)).toEqual(['background', 'background']);
    expect(state.provider).toHaveBeenCalledTimes(1);
    expect(state.releases[0]).toHaveBeenCalledTimes(1);
  });

  it('starts the timeout before the provider account queue can delay the request', async () => {
    state.provider.mockImplementation((_label: unknown, _messages: unknown, opts: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => opts.signal.addEventListener('abort', () => reject(opts.signal.reason))));
    const outcome = callWithFallback({ ...base, maxTimeoutMs: 1000 }).catch(err => err as Error);
    await vi.advanceTimersByTimeAsync(1001);
    expect(await outcome).toMatchObject({ name: 'TimeoutError' });
    expect(state.provider.mock.calls[0]![2].signal.aborted).toBe(true);
    expect(state.releases[0]).toHaveBeenCalledTimes(1);
  });
});
