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

  // ─── 回归：新 provider 永远排不上（2026-09-21 接 step-5-preview 时发现）──────
  //
  // 原实现给"没有延迟数据"的 provider 一个写死的 5_000ms。当时在跑的 provider
  // 平均延迟已经降到 2.8-3.2s，于是新来的永远排在链长之外 → 一次都不被调用 →
  // 永远拿不到数据 → 永远排不上去。"加一个 provider 就能用"是假的。
  //
  // 修法：无数据者按**池内已知延迟的中位数**归位，而不是一个拍死的常数。
  it('a brand-new provider is reachable even when every incumbent is fast', async () => {
    setLabels([
      makeLabel('inc1', { tier: 'high' }),
      makeLabel('inc2', { tier: 'high' }),
      makeLabel('inc3', { tier: 'high' }),
      makeLabel('inc4', { tier: 'high' }),
      makeLabel('inc5', { tier: 'high' }),
      makeLabel('newcomer', { tier: 'high' }), // 从未被调用 → 无延迟数据
    ]);
    // 5 个在跑的都明显快于旧的写死值 5000ms
    recordSmartGroupResult('inc1', 2800, true);
    recordSmartGroupResult('inc2', 2900, true);
    recordSmartGroupResult('inc3', 3000, true);
    recordSmartGroupResult('inc4', 3100, true);
    recordSmartGroupResult('inc5', 3200, true);

    const result = await smartGroupAutoAssign('reply'); // count = 5
    expect(result.length).toBe(5);
    expect(result).toContain('newcomer');
  });

  it('newcomer lands mid-pack, not first and not last', async () => {
    setLabels([
      makeLabel('fast', { tier: 'high' }),
      makeLabel('slow', { tier: 'high' }),
      makeLabel('newcomer', { tier: 'high' }),
    ]);
    recordSmartGroupResult('fast', 1_000, true);
    recordSmartGroupResult('slow', 9_000, true);
    const result = await smartGroupAutoAssign('reply');
    // 中位数 = 5000 → newcomer 排在 fast 之后、slow 之前
    expect(result.indexOf('newcomer')).toBeGreaterThan(result.indexOf('fast'));
    expect(result.indexOf('newcomer')).toBeLessThan(result.indexOf('slow'));
  });

  it('video usage 只收显式声明 video=true 的 label', async () => {
    // 方向与 vision 相反：vision 没声明就照发，video 没声明就不要。
    // 因为"返回 200"不等于"看得懂"——step-3.7-flash 收下 video_url、回 200、
    // content 为空（token 全烧 reasoning，finish=length）。
    setLabels([
      makeLabel('vidcap', { tier: 'high', capabilities: { video: true } }),
      makeLabel('vidcap2', { tier: 'medium', capabilities: { video: true } }),
      makeLabel('novid', { tier: 'high' }),                              // 没声明 → 排除
      makeLabel('vidfalse', { tier: 'high', capabilities: { video: false } }), // 明确 false → 排除
      makeLabel('visonly', { tier: 'high', capabilities: { vision: true } }),  // 只有 vision → 排除
    ]);
    const result = await smartGroupAutoAssign('video');
    expect(result).toContain('vidcap');
    expect(result).toContain('vidcap2');
    expect(result).not.toContain('novid');
    expect(result).not.toContain('vidfalse');
    expect(result).not.toContain('visonly');
  });

  it('没有任何 video-capable label 时返回空链（调用方回退手动链）', async () => {
    setLabels([
      makeLabel('a', { tier: 'high' }),
      makeLabel('b', { tier: 'high', capabilities: { vision: true } }),
    ]);
    expect(await smartGroupAutoAssign('video')).toEqual([]);
  });

  it('no latency data anywhere still yields a chain (fresh deploy)', async () => {
    setLabels([
      makeLabel('a', { tier: 'high' }),
      makeLabel('b', { tier: 'high' }),
      makeLabel('c', { tier: 'high' }),
    ]);
    const result = await smartGroupAutoAssign('reply');
    expect(result).toEqual(['a', 'b', 'c']);
  });
});
