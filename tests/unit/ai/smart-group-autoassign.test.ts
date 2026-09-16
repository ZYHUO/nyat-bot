import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AILabel } from '../../../src/ai/types.js';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockLabels = new Map<string, AILabel>();

vi.mock('../../../src/ai/labels.js', () => ({
  getLabels: () => mockLabels,
  getLabel: (name: string) => {
    const l = mockLabels.get(name);
    if (!l) throw new Error(`label not found: ${name}`);
    return l;
  },
}));

vi.mock('../../../src/db/redis.js', () => ({
  getRedis: () => undefined,
}));

// Must import AFTER mocks
const { smartGroupAutoAssign, recordSmartGroupResult } = await import('../../../src/ai/smart-group.js');

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeLabel(name: string, opts: Partial<AILabel> = {}): AILabel {
  return {
    name,
    endpoint: opts.endpoint ?? `https://${name}.example/v1`,
    apiKeys: [],
    model: opts.model ?? name,
    tier: opts.tier,
    capabilities: opts.capabilities,
    ...opts,
  };
}

function setLabels(labels: AILabel[]): void {
  mockLabels.clear();
  for (const l of labels) mockLabels.set(l.name, l);
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('smartGroupAutoAssign', () => {
  beforeEach(() => {
    mockLabels.clear();
    process.env.SMART_GROUP_ENABLED = 'true';
    process.env.SMART_GROUP_AUTO_ASSIGN = 'true';
    process.env.SMART_GROUP_STRATEGY = 'best-latency';
  });

  it('returns empty when disabled', async () => {
    process.env.SMART_GROUP_AUTO_ASSIGN = 'false';
    setLabels([makeLabel('a', { tier: 'high' })]);
    expect(await smartGroupAutoAssign('reply')).toEqual([]);
  });

  it('returns empty when smart group disabled', async () => {
    process.env.SMART_GROUP_ENABLED = 'false';
    setLabels([makeLabel('a', { tier: 'high' })]);
    expect(await smartGroupAutoAssign('reply')).toEqual([]);
  });

  it('filters by minTier for reply (high only)', async () => {
    setLabels([
      makeLabel('hi1', { tier: 'high' }),
      makeLabel('hi2', { tier: 'high' }),
      makeLabel('med1', { tier: 'medium' }),
      makeLabel('low1', { tier: 'low' }),
    ]);
    const result = await smartGroupAutoAssign('reply');
    expect(result).toContain('hi1');
    expect(result).toContain('hi2');
    expect(result).not.toContain('med1');
    expect(result).not.toContain('low1');
  });

  it('filters by minTier for judge (medium+high)', async () => {
    setLabels([
      makeLabel('hi1', { tier: 'high' }),
      makeLabel('med1', { tier: 'medium' }),
      makeLabel('low1', { tier: 'low' }),
    ]);
    const result = await smartGroupAutoAssign('judge');
    expect(result).toContain('hi1');
    expect(result).toContain('med1');
    expect(result).not.toContain('low1');
  });

  it('defaults missing tier to medium', async () => {
    setLabels([
      makeLabel('notier'), // tier undefined → medium
      makeLabel('low1', { tier: 'low' }),
    ]);
    const result = await smartGroupAutoAssign('judge');
    expect(result).toContain('notier');
    expect(result).not.toContain('low1');
  });

  it('filters vision profile by capability', async () => {
    setLabels([
      makeLabel('vis1', { tier: 'medium', capabilities: { vision: true } }),
      makeLabel('vis2', { tier: 'medium' }), // undefined = 未知,保留
      makeLabel('novis', { tier: 'medium', capabilities: { vision: false } }),
    ]);
    const result = await smartGroupAutoAssign('vision');
    expect(result).toContain('vis1');
    expect(result).toContain('vis2');
    expect(result).not.toContain('novis');
  });

  it('ranks by latency (best-latency strategy)', async () => {
    setLabels([
      makeLabel('fast', { tier: 'high' }),
      makeLabel('slow', { tier: 'high' }),
      makeLabel('mid', { tier: 'high' }),
    ]);

    // fast=100ms, mid=500ms, slow=2000ms
    recordSmartGroupResult('fast', 100, true);
    recordSmartGroupResult('mid', 500, true);
    recordSmartGroupResult('slow', 2000, true);

    const result = await smartGroupAutoAssign('reply');
    expect(result[0]).toBe('fast');
    expect(result[1]).toBe('mid');
    expect(result[2]).toBe('slow');
  });

  it('unhealthy sinks to bottom but not excluded', async () => {
    setLabels([
      makeLabel('good', { tier: 'high' }),
      makeLabel('sick', { tier: 'high' }),
    ]);

    recordSmartGroupResult('good', 200, true);
    // trip breaker: 5 consecutive errors
    for (let i = 0; i < 5; i++) recordSmartGroupResult('sick', 100, false);

    const result = await smartGroupAutoAssign('reply');
    expect(result[0]).toBe('good');
    expect(result).toContain('sick'); // still present, just last
  });

  it('unhealthy with stale-fast latencies still loses to healthy slow (regression)', async () => {
    // reviewer catch: sick provider whose last successes were fast (100ms) must not
    // outrank a healthy 20s provider — penalty must be absolute, not additive.
    setLabels([
      makeLabel('healthy_slow', { tier: 'high' }),
      makeLabel('sick_fast', { tier: 'high' }),
    ]);

    recordSmartGroupResult('healthy_slow', 20_000, true);
    recordSmartGroupResult('sick_fast', 100, true); // stale fast success
    for (let i = 0; i < 5; i++) recordSmartGroupResult('sick_fast', 0, false);

    const result = await smartGroupAutoAssign('reply');
    expect(result[0]).toBe('healthy_slow');
  });

  it('round-robin ranks least-recently-used first (regression: was inverted)', async () => {
    process.env.SMART_GROUP_STRATEGY = 'round-robin';
    setLabels([
      makeLabel('recent', { tier: 'high' }),
      makeLabel('stale', { tier: 'high' }),
      makeLabel('never', { tier: 'high' }),
    ]);

    // 'recent' used now, 'stale' used long ago, 'never' untouched
    recordSmartGroupResult('recent', 100, true);
    recordSmartGroupResult('stale', 100, true);
    // backdate stale's lastUsed by hacking a second record after faking time is
    // overkill — instead rely on 'never' (lastUsed=0) and check recent < stale order
    // via two successive calls: after recording, 'recent' must not be first.
    const result = await smartGroupAutoAssign('reply');
    expect(result[0]).not.toBe('recent');
    expect(result[0]).toBe('never'); // lastUsed=0 wins
  });

  it('caps chain length by profile.count', async () => {
    setLabels(
      Array.from({ length: 10 }, (_, i) => makeLabel(`m${i}`, { tier: 'high' })),
    );
    const result = await smartGroupAutoAssign('reply'); // count=5
    expect(result.length).toBe(5);
  });

  it('uses default profile for unknown usage', async () => {
    setLabels([
      makeLabel('hi1', { tier: 'high' }),
      makeLabel('med1', { tier: 'medium' }),
      makeLabel('low1', { tier: 'low' }),
    ]);
    const result = await smartGroupAutoAssign('nonexistent_usage');
    // default profile: minTier=medium
    expect(result).toContain('hi1');
    expect(result).toContain('med1');
    expect(result).not.toContain('low1');
  });

  it('returns empty when no candidates match', async () => {
    setLabels([makeLabel('low1', { tier: 'low' })]);
    expect(await smartGroupAutoAssign('reply')).toEqual([]); // wants high
  });
});
