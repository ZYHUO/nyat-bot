import { describe, it, expect } from 'vitest';
import { fitGroupPace } from '../../../src/pipeline/rhythm/group-pace.js';

function seq(values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length]!;
}

describe('fitGroupPace', () => {
  it('empty history → default base 2.5s', () => {
    expect(fitGroupPace([], 1)).toBe(2.5);
  });

  it('fast group (median gap 5s) → short base', () => {
    const now = 1000;
    const ts = [now - 25, now - 20, now - 15, now - 10, now - 5, now];
    const base = fitGroupPace(ts, 1);
    expect(base).toBeLessThan(2.5);
    expect(base).toBeGreaterThanOrEqual(0.8);
  });

  it('slow group (median gap 10min) → capped base', () => {
    const now = 100000;
    const ts = [0, 1, 2].map((i) => now - (2 - i) * 600);
    // median gap 600s → 0.15*600=90 → clamp 20
    expect(fitGroupPace(ts, 1)).toBe(20);
  });

  it('hot burst right now shortens base (0.6x)', () => {
    const now = 100000;
    // 中速群(中位间隔 60s → base 9),1 分钟 12 条 → ×0.6 = 5.4
    const slow = [0, 1, 2, 3, 4, 5].map((i) => now - 3600 + i * 60);
    const baseSlow = fitGroupPace(slow, 0);
    expect(baseSlow).toBeCloseTo(9, 1);
    const withBurst = [...slow, now - 20, now - 10, now];
    const baseBurst = fitGroupPace(withBurst, 12);
    expect(baseBurst).toBeLessThan(baseSlow);
  });

  it('deterministic given same input', () => {
    const ts = [100, 160, 200, 260, 320];
    expect(fitGroupPace(ts, 3)).toBe(fitGroupPace(ts, 3));
  });

  it('rng injection path exists on sampler (smoke)', async () => {
    const { sampleGroupDelay } = await import('../../../src/pipeline/rhythm/group-pace.js');
    const d = sampleGroupDelay(2, { rng: seq([0.5, 0.5, 0.5, 0.5]), circadian: false });
    expect(d).toBeGreaterThan(1.0);
    expect(d).toBeLessThan(4.0);
  });
});
