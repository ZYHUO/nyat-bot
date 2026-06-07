import { describe, it, expect } from 'vitest';
import { sampleHumanDelay } from '../../../src/pipeline/reply/latency-model.js';

function seq(values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length]!;
}

describe('latency model (#1 重尾延迟)', () => {
  it('fast lane stays near base (lognormal-ish)', () => {
    // rng: first call decides tail (0.5 → fast lane), next 3 → normal≈0
    const d = sampleHumanDelay(2, { rng: seq([0.5, 0.5, 0.5, 0.5]), circadian: false });
    expect(d).toBeGreaterThan(1.2);
    expect(d).toBeLessThan(3.5);
  });

  it('tail lane produces 3-10x slowdowns', () => {
    const d = sampleHumanDelay(2, { rng: seq([0.01, 0.5]), circadian: false, capSec: 60 });
    expect(d).toBeGreaterThanOrEqual(6); // 2 × (3 + 0.5*7) = 13 → ≥6 安全断言
  });

  it('respects cap and floor', () => {
    expect(sampleHumanDelay(100, { rng: seq([0.01, 0.99]), circadian: false, capSec: 20 })).toBe(20);
    expect(sampleHumanDelay(0.01, { rng: seq([0.5, 0.5, 0.5, 0.5]), circadian: false, floorSec: 0.3 })).toBe(0.3);
  });

  it('distribution sanity: most samples near base, some in the tail', () => {
    let near = 0, tail = 0;
    for (let i = 0; i < 2000; i++) {
      const d = sampleHumanDelay(2, { circadian: false, capSec: 60 });
      if (d < 5) near++;
      if (d >= 6) tail++;
    }
    expect(near / 2000).toBeGreaterThan(0.7);
    expect(tail / 2000).toBeGreaterThan(0.04);
    expect(tail / 2000).toBeLessThan(0.25);
  });
});
