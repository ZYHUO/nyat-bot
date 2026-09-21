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
    delete process.env.SMART_GROUP_DIVERSIFY_UPSTREAM;
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
    // 2026-09-21：这条断言**曾经钉着 bug 本身**。旧写法只排除显式
    // `vision: false`，未声明的文本 label 照样进 vision 链 —— 实测链是
    // `spark13(未声明) / stepfunthink(未声明) / step5(vision=true)`，
    // 前两个不能读图，`Vision failed, returning placeholder` 一天 434 次。
    // 现在和 video 同向：没声明 true 的一律排除。
    setLabels([
      makeLabel('vis1', { tier: 'medium', capabilities: { vision: true } }),
      makeLabel('vis2', { tier: 'medium' }), // undefined = 未知，**排除**
      makeLabel('novis', { tier: 'medium', capabilities: { vision: false } }),
    ]);
    const result = await smartGroupAutoAssign('vision');
    expect(result).toContain('vis1');
    expect(result).not.toContain('vis2');
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

  // ─── 2026-09-21：链的上游去重 ────────────────────────────────────────
  //
  // 健康 label 里 stepfun/stepfunjudge/stepfunthink/stepfunvision 四个共用同一个
  // endpoint + 同一个 key。按延迟排序它们连排，账号级限流一来四个同时死，
  // 链上瞬间一个不剩——而真正独立的 step5 / spark13 被挤出名額。
  // 日志实测那四个的失败是成片的（Empty response 1481/685/583/133）。
  describe('上游去重（同一 endpoint+key 只先取一个）', () => {
    const EP = 'https://api.stepfun.com/step_plan/v1';
    const upstream = (name: string, key: string, tier: 'high' | 'medium' = 'high') =>
      makeLabel(name, { endpoint: EP, apiKeys: [key], tier });

    it('四个同账号 label 只取最快那个，名額让给不同上游', async () => {
      setLabels([
        upstream('a1', 'sk-AAAAAAAAAAAAAAAA', 'high'),
        upstream('a2', 'sk-AAAAAAAAAAAAAAAA', 'high'),
        upstream('a3', 'sk-AAAAAAAAAAAAAAAA', 'high'),
        upstream('a4', 'sk-AAAAAAAAAAAAAAAA', 'high'),
        upstream('b1', 'sk-BBBBBBBBBBBBBBBB', 'high'),
        upstream('c1', 'sk-CCCCCCCCCCCCCCCC', 'high'),
      ]);
      // 延迟：a1 最快，a2/a3/a4 次之，b1/c1 慢
      recordSmartGroupResult('a1', 100, true);
      recordSmartGroupResult('a2', 200, true);
      recordSmartGroupResult('a3', 300, true);
      recordSmartGroupResult('a4', 400, true);
      recordSmartGroupResult('b1', 900, true);
      recordSmartGroupResult('c1', 950, true);

      const chain = await smartGroupAutoAssign('reply'); // count=5
      // 关键性质：**前几个是不同上游**。a 账号只出一个（最快的 a1），
      // 名額先给 b/c，然后才用同账号的 a2/a3 补满。
      expect(chain.slice(0, 3)).toEqual(['a1', 'b1', 'c1']);
      expect(chain.length).toBe(5);
      // 补位的才是同账号的
      expect(chain.slice(3).every((n) => n.startsWith('a'))).toBe(true);
    });

    it('不同 endpoint 同 key 也算不同上游（key 相同但服务不同）', async () => {
      setLabels([
        makeLabel('x1', { endpoint: 'https://a.example/v1', apiKeys: ['sk-SAMEKEY123456'], tier: 'high' }),
        makeLabel('y1', { endpoint: 'https://b.example/v1', apiKeys: ['sk-SAMEKEY123456'], tier: 'high' }),
      ]);
      const chain = await smartGroupAutoAssign('reply');
      expect(chain).toContain('x1');
      expect(chain).toContain('y1');
    });

    it('关掉开关 → 回到纯延迟排序（不去重）', async () => {
      process.env.SMART_GROUP_DIVERSIFY_UPSTREAM = 'false';
      setLabels([
        upstream('a1', 'sk-AAAAAAAAAAAAAAAA'),
        upstream('a2', 'sk-AAAAAAAAAAAAAAAA'),
        upstream('b1', 'sk-BBBBBBBBBBBBBBBB'),
      ]);
      recordSmartGroupResult('a1', 100, true);
      recordSmartGroupResult('a2', 200, true);
      recordSmartGroupResult('b1', 900, true);
      const chain = await smartGroupAutoAssign('reply');
      expect(chain.slice(0, 2)).toEqual(['a1', 'a2']); // 纯延迟，同账号连排
    });

    it('去重不减少链长（名額照满）', async () => {
      setLabels([
        upstream('a1', 'sk-AAAAAAAAAAAAAAAA'),
        upstream('a2', 'sk-AAAAAAAAAAAAAAAA'),
        upstream('a3', 'sk-AAAAAAAAAAAAAAAA'),
        upstream('b1', 'sk-BBBBBBBBBBBBBBBB'),
        upstream('b2', 'sk-BBBBBBBBBBBBBBBB'),
        upstream('c1', 'sk-CCCCCCCCCCCCCCCC'),
      ]);
      for (const n of ['a1', 'a2', 'a3', 'b1', 'b2', 'c1']) recordSmartGroupResult(n, 100, true);
      const chain = await smartGroupAutoAssign('reply');
      expect(chain.length).toBe(5); // count=5，去重后仍补满
      expect(new Set(chain).size).toBe(5);
    });

    it('不健康的 label 仍然垫底（去重不改变健康优先）', async () => {
      setLabels([
        upstream('sick', 'sk-AAAAAAAAAAAAAAAA'),
        upstream('good', 'sk-BBBBBBBBBBBBBBBB'),
      ]);
      recordSmartGroupResult('good', 500, true);
      for (let i = 0; i < 5; i++) recordSmartGroupResult('sick', 10, false);
      const chain = await smartGroupAutoAssign('reply');
      expect(chain[0]).toBe('good');
      expect(chain).toContain('sick');
    });
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

// ─── 2026-09-21：两个选路缺陷 ────────────────────────────────────────────
//
// ① `healthy` 的语义是"熔断器没跳"（errorCount < 5），不是"这东西能用"。
//    一个 label 初始就是 healthy=true / successCount=0，试一两次失败也还是
//    healthy —— 于是它和真能用的 label 拿同一个新来者中位数分，平起平坐。
//    实测：`dsv4flash`（指向 127.0.0.1:3000，那端口上什么都没有）在 health
//    ledger 里是 `healthy=1 succ=0 err=3`，照样进 judge 链第二位。
//
// ② vision profile 的过滤旧写法是 `=== false`（只排除显式声明不支持的），
//    未声明的文本 label 照样进 vision 链。实测 vision 链排出来是
//    `spark13(未声明) / stepfunthink(未声明) / step5(vision=true)`，
//    前两个根本不能读图 —— `Vision failed, returning placeholder` 一天 434 次。
describe('选路：零成功 demote + vision 严格过滤', () => {
  beforeEach(() => {
    mockLabels.clear();
    process.env.SMART_GROUP_ENABLED = 'true';
    process.env.SMART_GROUP_AUTO_ASSIGN = 'true';
    process.env.SMART_GROUP_STRATEGY = 'best-latency';
    delete process.env.SMART_GROUP_DIVERSIFY_UPSTREAM;
  });

  it('① 从未成功的 label 排到所有有实测的之后', async () => {
    // 两个有实测的：1000 和 5000 → 新来者中位数 = 3000。
    // `slow` 实测 5000 → 得分 -5000；`never` 零成功 → 新来者分 -3000。
    // **没有 demote 的话 -3000 > -5000，never 会排到 slow 前面。**
    // 加了 demote 之后 never = -(5000+3000) = -8000，落到最后。
    setLabels([
      makeLabel('slow', { tier: 'high' }),
      makeLabel('never', { tier: 'high' }),
      makeLabel('fast', { tier: 'high' }),
    ]);
    recordSmartGroupResult('fast', 1000, true);
    recordSmartGroupResult('slow', 5000, true);
    recordSmartGroupResult('never', 100, false);   // 只失败过，没成功过
    const chain = await smartGroupAutoAssign('judge');
    expect(chain.indexOf('never')).toBe(chain.length - 1);
    expect(chain[0]).toBe('fast');
  });

  it('①b 一次成功就归位（新 provider 仍进得来，只是要先证明自己）', async () => {
    setLabels([makeLabel('proven', { tier: 'high' }), makeLabel('newbie', { tier: 'high' })]);
    recordSmartGroupResult('proven', 5000, true);
    recordSmartGroupResult('newbie', 1000, true);   // 成功了
    const chain = await smartGroupAutoAssign('judge');
    expect(chain[0]).toBe('newbie');                // 1000 < 5000，正常按延迟排
  });

  it('①c 全部零成功时仍能排出链（不返回空）', async () => {
    setLabels([makeLabel('a', { tier: 'high' }), makeLabel('b', { tier: 'high' })]);
    recordSmartGroupResult('a', 100, false);
    recordSmartGroupResult('b', 200, false);
    const chain = await smartGroupAutoAssign('judge');
    expect(chain.length).toBe(2);
  });

  it('② vision 链只收声明 vision=true 的（未声明的一律排除）', async () => {
    setLabels([
      makeLabel('sees', { tier: 'high', capabilities: { vision: true } }),
      makeLabel('undeclared', { tier: 'high' }),
      makeLabel('textonly', { tier: 'high', capabilities: { vision: false } }),
    ]);
    const chain = await smartGroupAutoAssign('vision');
    expect(chain).toEqual(['sees']);
  });

  it('②b vision=false 与未声明同样被排除（两者都不能读图）', async () => {
    setLabels([
      makeLabel('sees', { tier: 'medium', capabilities: { vision: true } }),
      makeLabel('nope', { tier: 'medium', capabilities: { vision: false } }),
    ]);
    expect(await smartGroupAutoAssign('vision')).toEqual(['sees']);
  });

  it('②c 没有 vision-capable 候选 → 返回空（调用方回退手动链），不硬塞文本 label', async () => {
    setLabels([makeLabel('textonly', { tier: 'high', capabilities: { vision: false } })]);
    expect(await smartGroupAutoAssign('vision')).toEqual([]);
  });

  it('②d 非 vision usage 不受影响（judge 照旧收文本 label）', async () => {
    setLabels([
      makeLabel('sees', { tier: 'high', capabilities: { vision: true } }),
      makeLabel('textonly', { tier: 'high', capabilities: { vision: false } }),
    ]);
    const chain = await smartGroupAutoAssign('judge');
    expect(chain).toContain('textonly');
  });

  it('②e video 仍然是严格的（这次改动没动它）', async () => {
    setLabels([
      makeLabel('vids', { tier: 'high', capabilities: { video: true } }),
      makeLabel('sees', { tier: 'high', capabilities: { vision: true } }),
    ]);
    expect(await smartGroupAutoAssign('video')).toEqual(['vids']);
  });

  // round 98：中位延迟超纲的 label 不进链。
  //
  // 起因：spark13 中位 19.8s，而 judge/summarize 链上的调用方只肯等 12s
  // （topic-scan maxTimeoutMs 12000）。`callModel` 取 min(usage.timeout,
  // options.maxTimeoutMs)——调用方的 cap 赢，provider 配的 60s 不起作用。
  // 于是链变长之后，第一位失败要退到第四位，每跳烧一个超时，三跳 36-60 秒。
  // round 95 等长窗口五项全差，我先后归因给并发闸和"新 provider 不稳"，都错。
  describe('中位延迟超纲剔除', () => {
    it('① 中位延迟超过 profile 上限的 label 被剔除（judge 上限 8s）', async () => {
      setLabels([
        makeLabel('fast', { tier: 'medium' }),
        makeLabel('slow', { tier: 'medium' }),
      ]);
      // 通过内部健康账把 slow 的滑窗中位推到 30s
      const mod = await import('../../../src/ai/smart-group.js');
      const rec = (mod as unknown as { __recordHealthForTest?: (n: string, lat: number[]) => void }).__recordHealthForTest;
      if (rec) {
        rec('fast', [1000, 1200]);
        rec('slow', [28000, 30000, 32000]);
      }
      const chain = await smartGroupAutoAssign('judge', { count: 4, diversify: false } as never);
      expect(chain).toContain('fast');
      expect(chain).not.toContain('slow');
    });
  });

  // round 102：成功率不达标的不进链（judge 门槛 60%、样本 20）。
  //
  // 起因：round 98 只加了"够快"（延迟上限），把两个慢但稳的（spark13 19.8s /
  // amdqwen 5.9s，实测 19/20、20/20）挡掉，换进来三个快但错的。同窗口 22 次错误
  // 全来自替补位。所以链位有两个条件：够快 + 够稳。
  //
  // 第一版用累计 successCount/(succ+err)，结果把 stepfunvision（同窗口 71 成 0 败）
  // 也踢出去了——它的累计账里背着整段 7864 断额、整段外网中断、整段并发风暴。
  // 和 round 87 的熔断键同病：旧状态押着新时段。改成窗口化 recentOutcomes。
  describe('成功率不达标剔除', () => {
    /** 往健康账里塞窗口化结果。 */
    const seed = async (n: string, ring: number[]): Promise<void> => {
      const mod = await import('../../../src/ai/smart-group.js');
      (mod as unknown as { __recordHealthForTest: (n: string, lat: number[], extra: Record<string, unknown>) => void })
        .__recordHealthForTest(n, [1000], { recentOutcomes: ring });
    };
    it('① 窗口成功率低于 60% 的被剔除', async () => {
      setLabels([makeLabel('good', { tier: 'medium' }), makeLabel('bad', { tier: 'medium' })]);
      await seed('good', Array(20).fill(1));
      await seed('bad', [1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]); // 10%
      const chain = await smartGroupAutoAssign('judge', { count: 4, diversify: false } as never);
      expect(chain).toContain('good');
      expect(chain).not.toContain('bad');
    });

    it('② 样本不足 20 次时不判（新 provider 仍然进得来）', async () => {
      setLabels([makeLabel('newcomer', { tier: 'medium' })]);
      await seed('newcomer', [0, 0, 0]); // 全败，但只有 3 个样本
      const chain = await smartGroupAutoAssign('judge', { count: 4, diversify: false } as never);
      expect(chain).toContain('newcomer');
    });

    it('③ 窗口化而非累计：早期失败多、近期全成的 label 照样进', async () => {
      setLabels([makeLabel('recovered', { tier: 'medium' })]);
      // 累计看是 8/28 = 29%，但窗口（最近 20）是 20/20 = 100%
      await seed('recovered', [...Array(8).fill(0), ...Array(20).fill(1)]);
      const chain = await smartGroupAutoAssign('judge', { count: 4, diversify: false } as never);
      expect(chain).toContain('recovered');
    });

    it('④ 零成功是强信号：5 次全败就挡，不用等满 20 个样本', async () => {
      setLabels([makeLabel('good', { tier: 'medium' }), makeLabel('neverworks', { tier: 'medium' })]);
      await seed('good', Array(20).fill(1));
      await seed('neverworks', [0, 0, 0, 0, 0]); // 只有 5 个样本，但一个都没成
      const chain = await smartGroupAutoAssign('judge', { count: 4, diversify: false } as never);
      expect(chain).toContain('good');
      expect(chain).not.toContain('neverworks');
    });

    it('⑤ 但 4 次全败还不挡（样本不够，可能是新 provider 运气差）', async () => {
      setLabels([makeLabel('newcomer', { tier: 'medium' })]);
      await seed('newcomer', [0, 0, 0, 0]);
      const chain = await smartGroupAutoAssign('judge', { count: 4, diversify: false } as never);
      expect(chain).toContain('newcomer');
    });
  });
});
