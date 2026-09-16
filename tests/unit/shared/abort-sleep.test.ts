// sleepWithAbort:关机/打断信号能立即叫醒 humanizer 长睡眠(不抛,调用方自查)
import { describe, it, expect, vi, afterEach } from 'vitest';
import { sleepWithAbort } from '../../../src/shared/abort.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('sleepWithAbort', () => {
  it('无信号:按时长睡满', async () => {
    vi.useFakeTimers();
    let done = false;
    const p = sleepWithAbort(5_000).then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(done).toBe(true);
  });

  it('睡眠中途 abort → 立即 resolve(不必睡满,不抛)', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let done = false;
    const p = sleepWithAbort(40_000, controller.signal).then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(done).toBe(false);
    controller.abort(Object.assign(new Error('shutdown'), { name: 'Shutdown' }));
    await p; // 不 advance 剩余 39s —— abort 即醒
    expect(done).toBe(true);
  });

  it('信号已 aborted → 同步直接 resolve,不挂 timer', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(sleepWithAbort(60_000, controller.signal)).resolves.toBeUndefined();
  });
});
