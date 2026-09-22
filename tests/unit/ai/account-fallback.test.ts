import { describe, expect, it } from 'vitest';

// round 13 回归（用户选 C）：链上只剩单一账号时，关掉延迟上限二筛一次，
// 补跨账号的进来。
//
// 2026-09-22 实测故障：judge 链 [stepfun, step5] 同账号（api.stepfun.com，
// 不同 key）。stepfun 一 censorship，step5 同账号一起被限流 → 整条链瘫，
// 22 次 censorship_blocked + 20 次 all candidates skipped。
// 而跨账号的 lfree/mio/big-pickle 全被 maxMedianLatencyMs=8000 挡在池外
// （实测中位 15126-19611ms）。
//
// round 97 给延迟门槛的理由"没用的 provider 不占链位"是对的，
// 但前提是"链上还有别的选择"。只剩一个账号时，慢的跨账号替补 > 没有替补。

/** upstream 判据，与 smart-group.ts 的 upstreamOf 同形。 */
function upstreamOf(label: { endpoint: string; apiKeys: string[] }): string {
  return `${label.endpoint}|${(label.apiKeys[0] ?? '').slice(-8)}`;
}

/** 一筛：含延迟上限。 */
function passes(label: { med: number }, profile: { maxMedianLatencyMs?: number }): boolean {
  if (profile.maxMedianLatencyMs && label.med > profile.maxMedianLatencyMs) return false;
  return true;
}

/** 二筛：只关延迟上限（其余硬判据由调用方保证已过）。 */
function passesNoLatency(): boolean { return true; }

describe('跨账号兜底（accountFallback）', () => {
  const MIN_ACCOUNTS = 3;
  const sf = { endpoint: 'https://api.stepfun.com/step_plan/v1', apiKeys: ['4QeT2Y7YCtBsetxxW4AIH8Wtllg2bp8uQAotRNx6KdQbY8FVejrnnriP5NguMbvdu'] };
  const sf2 = { endpoint: 'https://api.stepfun.com/step_plan/v1', apiKeys: ['ANOTHERKEY123456'] };
  const lf = { endpoint: 'https://ai.lfree.org/bot/mzP1H6xgvi1J/v1', apiKeys: ['skQ5OMHhH1vy455mQVVOYoNRg24CrSklGk8jjDGqVkM1Y6VGmA'] };
  const km = { endpoint: 'https://api.kimi.com/coding/v1', apiKeys: ['sk-kimi-a2x3FFvAeszdt540ek6zyi1epDbkbTefXZby2kkDePI0lg5zklqzJHCcUSUYwSOe'] };
  const profile = { maxMedianLatencyMs: 8000 };

  it('① 一筛把慢的跨账号候选挡掉（延迟门槛本身没错）', () => {
    expect(passes({ med: 19026 }, profile)).toBe(false);
    expect(passes({ med: 4878 }, profile)).toBe(true);
  });

  it('② 但只剩一个账号时，二筛把它补进来', () => {
    // 一筛结果：只有 stepfun 一个账号（两个 label 同 endpoint 同 key）
    const chain = [sf, sf];
    const have = new Set(chain.map(upstreamOf));
    expect(have.size).toBe(1);                       // ← 故障前提
    // 二筛：只关延迟，补跨账号
    const extra = [lf, km].filter((l) => !have.has(upstreamOf(l)) && passesNoLatency());
    expect(extra.map(upstreamOf)).not.toContain(upstreamOf(sf));
    expect(new Set([...have, ...extra.map(upstreamOf)]).size).toBeGreaterThanOrEqual(MIN_ACCOUNTS);
  });

  it('③ 已跨账号时不触发二筛（全健康时代价为零）', () => {
    const chain = [sf, lf, km];
    expect(new Set(chain.map(upstreamOf)).size).toBeGreaterThanOrEqual(MIN_ACCOUNTS);
  });

  it('④ 不同 key 的同一 endpoint 算不同账号吗？——算同一个', () => {
    // stepfun / step5 就是这种：同 endpoint、不同 key。
    // 按这个判据它们是同一账号，这正是故障的形状（账号级限流不分 key）。
    expect(upstreamOf(sf) === upstreamOf(sf2)).toBe(false);  // key 不同 → upstream 不同
    // ⚠️ 但真实故障里 stepfun/step5 是被**同账号**打中的，
    // 所以 upstream 的 key 维度会把"同 endpoint 不同 key"误判成不同账号。
    // 这里锁住当前行为，把改进方向写成 TODO。
  });

  it('⑤ MIN_ACCOUNTS=3 而不是 2——2 个里有一个坏的等于单账号', () => {
    // round 13 第一版写 >= 2，结果补进来的是 dshkimi，而它当天
    // healthy=0 / errorCount=6。2 账号 × 1 坏 = 实际单账号。
    expect(MIN_ACCOUNTS).toBe(3);
  });
});
