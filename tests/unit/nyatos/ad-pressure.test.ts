/**
 * 反广告 · 行为气压。
 *
 * 锁的核心不变量：**这不是规则引擎**。
 *   - 没有内容关键词：把经典广告文案原样喂进去，adP 仍应为 0
 *   - 判定只来自行为：burst / echo / repeat / spread
 *   - 群主没授权 → 整体不工作（零呈现、零记录）
 *   - 输出是事实不是裁决（renderAdPressure 的话术是"你定"）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const hash = new Map<string, Map<string, string>>();
const zset = new Map<string, Map<string, number>>();
const sets = new Map<string, Set<string>>();

const redisMock = {
  get: vi.fn(async (k: string) => hash.get(k)?.get('v') ?? null),
  set: vi.fn(async (k: string, v: string) => { if (!hash.has(k)) hash.set(k, new Map()); hash.get(k)!.set('v', v); return 'OK'; }),
  del: vi.fn(async (k: string) => (hash.delete(k) ? 1 : 0)),
  multi: () => {
    const q: Array<() => Promise<unknown>> = [];
    const pipe = {
      zadd: (k: string, _s: string, m: string) => { q.push(async () => { if (!zset.has(k)) zset.set(k, new Map()); zset.get(k)!.set(m, Number(_s)); return 1; }); return pipe; },
      // 按分数区间真删（第一版这里 clear() 整个 zset，而实现是 zadd 之后调它，
      // 结果刚写进去的样本立刻被抹光——所有计数断言全返 0，而实现是对的）。
      zremrangebyscore: (k: string, min: string, max: string) => {
        q.push(async () => {
          const z = zset.get(k);
          if (!z) return 0;
          const lo = min === '-inf' ? -Infinity : Number(String(min).replace(/^\(/, ''));
          const hi = max === '+inf' ? Infinity : Number(String(max).replace(/^\(/, ''));
          for (const [member, score] of [...z.entries()]) {
            if (score >= lo && score <= hi) z.delete(member);
          }
          return 0;
        });
        return pipe;
      },
      expire: () => { q.push(async () => 1); return pipe; },
      sadd: (k: string, m: string) => { q.push(async () => { if (!sets.has(k)) sets.set(k, new Set()); sets.get(k)!.add(m); return 1; }); return pipe; },
      exec: async () => { for (const f of q) await f(); return []; },
    };
    return pipe;
  },
  zrangebyscore: vi.fn(async (k: string, _a: number, _b: number) => [...(zset.get(k)?.keys() ?? [])]),
  smembers: vi.fn(async (k: string) => [...(sets.get(k) ?? [])]),
};
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => redisMock }));

const m = await import('../../../src/nyatos/ad-pressure.js');

beforeEach(() => { hash.clear(); zset.clear(); sets.clear(); redisMock.get.mockClear(); });

const CHAT = -1009999001;
const SPAMMER = 111222333;
const HUMAN = 444555666;

describe('反广告 · 行为气压', () => {
  it('群主没授权 → 整体不工作', async () => {
    expect(await m.antiAdEnabled(CHAT)).toBe(false);
    expect(await m.renderAdPressure(CHAT, [{ uid: SPAMMER }])).toBe('');
  });

  it('群主授权后可开可关（可带 TTL）', async () => {
    await m.setAntiAd(CHAT, true);
    expect(await m.antiAdEnabled(CHAT)).toBe(true);
    await m.setAntiAd(CHAT, false);
    expect(await m.antiAdEnabled(CHAT)).toBe(false);
    await m.setAntiAd(CHAT, true, 60);
    expect(await m.antiAdEnabled(CHAT)).toBe(true);
  });

  it('**不是规则引擎**：经典广告文案 adP 仍为 0', async () => {
    await m.setAntiAd(CHAT, true);
    const now = 1_800_000_000;
    // 典型广告文案：手机号 + 微信 + 兼职 + 链接，一条而已
    await m.noteInbound(CHAT, SPAMMER, '加微信 vx88888 手机 13800138000 日结兼职 https://t.cn/x', now);
    const s = await m.readAdSignals(CHAT, SPAMMER, now);
    expect(s.adP).toBe(0);
    expect(s.count).toBe(1);
  });

  it('刷屏行为才推高 adP（burst）', async () => {
    await m.setAntiAd(CHAT, true);
    const now = 1_800_000_000;
    for (let i = 0; i < 8; i++) {
      await m.noteInbound(CHAT, SPAMMER, `第${i}条完全不同的话`, now);
    }
    const s = await m.readAdSignals(CHAT, SPAMMER, now);
    expect(s.count).toBe(8);
    expect(s.adP).toBeGreaterThan(0);
  });

  it('有人接话会压低 adP（echo 是反向信号）', async () => {
    await m.setAntiAd(CHAT, true);
    const now = 1_800_000_000;
    for (let i = 0; i < 8; i++) await m.noteInbound(CHAT, SPAMMER, `话${i}`, now);
    const before = await m.readAdSignals(CHAT, SPAMMER, now);
    for (let i = 0; i < 5; i++) await m.noteEngaged(CHAT, SPAMMER, now);
    const after = await m.readAdSignals(CHAT, SPAMMER, now);
    expect(after.engaged).toBe(5);
    expect(after.adP).toBeLessThanOrEqual(before.adP);
    expect(after.echoRate).toBeGreaterThan(before.echoRate);
  });

  it('近重复内容计入 repeats', async () => {
    await m.setAntiAd(CHAT, true);
    const now = 1_800_000_000;
    for (let i = 0; i < 5; i++) await m.noteInbound(CHAT, SPAMMER, '一模一样的一句话啊', now);
    const s = await m.readAdSignals(CHAT, SPAMMER, now);
    expect(s.repeats).toBe(4);
  });

  it('adP 有上界（钳到 AD_P_MAX）', async () => {
    await m.setAntiAd(CHAT, true);
    const now = 1_800_000_000;
    for (let i = 0; i < 40; i++) await m.noteInbound(CHAT, SPAMMER, '重复重复重复', now);
    const s = await m.readAdSignals(CHAT, SPAMMER, now);
    expect(s.adP).toBeLessThanOrEqual(m.AD_P_MAX);
  });

  it('呈现是事实不是裁决（话术含"你定"）', async () => {
    await m.setAntiAd(CHAT, true);
    const now = 1_800_000_000;
    for (let i = 0; i < 8; i++) await m.noteInbound(CHAT, SPAMMER, `x${i}`, now);
    const out = await m.renderAdPressure(CHAT, [{ uid: SPAMMER, name: '测试号' }]);
    expect(out).toContain('[噪声]');
    expect(out).toContain('你定');
    expect(out).toContain('条/5分钟');
  });

  it('正常聊天的人不出现', async () => {
    await m.setAntiAd(CHAT, true);
    const now = 1_800_000_000;
    await m.noteInbound(CHAT, HUMAN, '今天天气不错', now);
    expect(await m.renderAdPressure(CHAT, [{ uid: HUMAN }])).toBe('');
  });
});
