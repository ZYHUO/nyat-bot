import { afterEach, describe, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ session: vi.fn(), requeue: vi.fn(), size: vi.fn() }));
vi.mock('../../../src/env.js', () => ({ env: () => ({ META_SUBAGENT_ENABLED: true, META_TICK_MS: 30_000 }) }));
vi.mock('../../../src/startup/ownership.js', () => ({ getStartupOwnership: () => ({}), ownsMetaLoop: () => true }));
vi.mock('../../../src/meta/session.js', () => ({ runMetaSession: f.session }));
vi.mock('../../../src/meta/global-state.js', () => ({ getGlobalState: () => ({ drainCallbacks: async () => [] }) }));
vi.mock('../../../src/meta/attention.js', () => ({ getAttentionAccumulator: () => ({
  size: f.size, flush: async () => [{ id: 'synthetic' }], requeue: f.requeue,
}) }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn() } }));
afterEach(() => { vi.useRealTimers(); vi.resetModules(); vi.clearAllMocks(); });
describe('Meta shutdown joins session and failure requeue', () => {
  it.each([false, true])('waits for the actual session (failure=%s)', async (fail) => {
    vi.useFakeTimers(); let settle!: () => void;
    f.size.mockResolvedValue(1); f.requeue.mockResolvedValue(undefined);
    f.session.mockImplementation(() => new Promise<void>((resolve, reject) => {
      settle = () => fail ? reject(new Error('synthetic failure')) : resolve();
    }));
    const { metaTick, drainMetaLoop } = await import('../../../src/meta/loop.js');
    const tick = metaTick(); await vi.advanceTimersByTimeAsync(0);
    let drained = false;
    const drain = drainMetaLoop().then(() => { drained = true; });
    await vi.advanceTimersByTimeAsync(60_000); await metaTick();
    expect(f.session).toHaveBeenCalledOnce(); expect(drained).toBe(false);
    settle(); await tick; await drain;
    expect(f.requeue).toHaveBeenCalledTimes(fail ? 1 : 0);
  });
});
