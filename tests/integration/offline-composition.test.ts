import { describe, expect, it, vi } from 'vitest';

const reads = vi.hoisted(() => ({ get: vi.fn(async (key: string) => key === 'xxb:trench:p:-123' ? '6' : null) }));
vi.mock('../../src/db/redis.js', () => ({ getRedis: () => reads }));
vi.mock('../../src/env.js', () => ({ env: () => ({ TRENCH_DEBT_ENABLED: false }) }));
vi.mock('../../src/shared/logger.js', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

describe('offline body-signal composition', () => {
  it('real modules register and render through the shared registry without authorizing anti-ad', async () => {
    await import('../../src/nyatos/trench.js');
    await import('../../src/nyatos/debt.js');
    await import('../../src/nyatos/ad-pressure.js');
    const { listBodySignals, collectBodyFacts } = await import('../../src/nyatos/body-signal.js');
    const { renderTrench, readTrench } = await import('../../src/nyatos/trench.js');
    expect(listBodySignals().map(signal => signal.id).sort()).toEqual(['adPressure', 'debt', 'trench']);
    const expected = renderTrench(await readTrench(-123));
    expect(expected.length).toBeGreaterThan(0);
    expect(await collectBodyFacts(-123, { senders: [{ uid: 99 }] })).toEqual([expected]);
    expect(reads.get).toHaveBeenCalledWith('xxb:trench:antiad:-123');
  });
});
