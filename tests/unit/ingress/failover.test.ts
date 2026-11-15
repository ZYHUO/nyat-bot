import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../../src/shared/logger.js', () => ({ logger: { child: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }) } }));
import { startIngressWatchdog } from '../../../src/ingress/failover.js';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
describe('polling recovery respects available transport', () => {
  it.each([false, true])('only switches to a usable webhook: %s', async available => {
    vi.useFakeTimers(); vi.spyOn(process, 'uptime').mockReturnValue(600);
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const redis = { get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue('OK') };
    startIngressWatchdog(redis as never, 'polling', { webhookAvailable: available });
    await vi.advanceTimersByTimeAsync(120000);
    expect(redis.set).toHaveBeenCalledWith('xxb:ingress:mode', available ? 'webhook' : 'polling');
    if (!available) expect(redis.set).not.toHaveBeenCalledWith('xxb:ingress:webhook_since', expect.anything());
    expect(exit).toHaveBeenCalledOnce();
  });
});
