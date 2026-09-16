import { describe, it, expect } from 'vitest';
import { filterByPercentile } from '../../../src/pipeline/context/retriever.js';

// Lightweight scored item for testing the pure helper.
interface Item {
  id: string;
  score?: number;
}

const item = (id: string, score?: number): Item => ({ id, score });
const ids = (items: Item[]) => items.map((i) => i.id);

const OPTS = { pct: 0.75, minResults: 3, minScore: 0.3 };

describe('filterByPercentile', () => {
  it('drops weak candidates below the 75th-percentile threshold', () => {
    // 8 candidates; 75th percentile keeps roughly the top quartile, but minResults=3
    // guarantees at least 3 survive. The clearly-weak ones must be gone.
    const items = [
      item('a', 0.95),
      item('b', 0.90),
      item('c', 0.85),
      item('d', 0.80),
      item('e', 0.50),
      item('f', 0.45),
      item('g', 0.40),
      item('h', 0.35),
    ];
    const out = filterByPercentile(items, (i) => i.score, OPTS);
    // The two lowest must be dropped; the top ones must remain.
    expect(out).toContain(items[0]);
    expect(out).toContain(items[1]);
    expect(out).not.toContain(items[7]); // 0.35 weak
    expect(out).not.toContain(items[6]); // 0.40 weak
    // Order is preserved relative to input.
    expect(out).toEqual(items.filter((i) => out.includes(i)));
  });

  it('keeps the top MIN_RESULTS even when all but a few are low', () => {
    // Only 3 strong, rest weak — but several weak still clear the 0.3 floor.
    // The percentile would normally keep very few, but minResults=3 forces 3.
    const items = [
      item('hi1', 0.9),
      item('hi2', 0.88),
      item('hi3', 0.86),
      item('lo1', 0.31),
      item('lo2', 0.31),
      item('lo3', 0.31),
    ];
    const out = filterByPercentile(items, (i) => i.score, OPTS);
    expect(out.length).toBeGreaterThanOrEqual(3);
    // The 3 strongest are always present.
    expect(out).toContain(items[0]);
    expect(out).toContain(items[1]);
    expect(out).toContain(items[2]);
  });

  it('respects the MIN_SCORE hard floor even against minResults fallback', () => {
    // All candidates below the 0.3 floor → nothing survives, even though
    // minResults would otherwise want to keep 3.
    const items = [
      item('a', 0.29),
      item('b', 0.20),
      item('c', 0.10),
      item('d', 0.05),
    ];
    const out = filterByPercentile(items, (i) => i.score, OPTS);
    expect(out).toEqual([]);
  });

  it('keeps only floor-clearing items when minResults fallback engages', () => {
    // 2 strong above floor, rest below — minResults=3 tries to grab 3, but the
    // floor strips the sub-0.3 one back out.
    const items = [
      item('a', 0.9),
      item('b', 0.8),
      item('c', 0.25), // below floor
      item('d', 0.20), // below floor
    ];
    const out = filterByPercentile(items, (i) => i.score, OPTS);
    expect(ids(out).sort()).toEqual(['a', 'b']);
  });

  it('is a no-op when no scores are available (scores undefined)', () => {
    const items = [item('a'), item('b'), item('c'), item('d')];
    const out = filterByPercentile(items, (i) => i.score, OPTS);
    expect(out).toEqual(items);
  });

  it('treats NaN scores as unscoreable and passes them through', () => {
    const items = [item('a', NaN), item('b', NaN)];
    const out = filterByPercentile(items, (i) => i.score, OPTS);
    expect(out).toEqual(items);
  });

  it('passes unscored items through alongside filtered scored ones', () => {
    // Mixed batch: some scoreable (one weak), some unscoreable.
    const items = [
      item('strong', 0.9),
      item('weak', 0.31),
      item('unscored1'),
      item('unscored2'),
    ];
    const out = filterByPercentile(items, (i) => i.score, OPTS);
    // Unscored items always survive.
    expect(out).toContain(items[2]);
    expect(out).toContain(items[3]);
    // Strong scored survives.
    expect(out).toContain(items[0]);
  });

  it('returns [] for empty input', () => {
    expect(filterByPercentile([], (i: Item) => i.score, OPTS)).toEqual([]);
  });

  it('preserves input order in the output (no reordering by score)', () => {
    // All equal scores → percentile threshold equals that score, everything is
    // kept, and the output must keep input order rather than sort by score.
    const items = [
      item('z', 0.8),
      item('y', 0.8),
      item('x', 0.8),
      item('w', 0.8),
    ];
    const out = filterByPercentile(items, (i) => i.score, OPTS);
    expect(ids(out)).toEqual(['z', 'y', 'x', 'w']);
  });
});
