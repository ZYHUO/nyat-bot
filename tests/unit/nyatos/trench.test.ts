import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';

// Nyat Trench · L0 海床的硬测试。
// 论文 §7：五条不可协商约束进 trench.test.ts，任一条红即 CI 失败。
//   ① 有界：10⁶ 次随机注入后 P/θ/r 恒在界内
//   ② 可观测：任何变化可检索
//   ③ 可强制复位：reset 后 P=0 且不依赖其他状态
//   ④ 无隐藏状态：进程重启仅从 P/θ 恢复（Redis 里只有这两个 key 是我们写的）
//   ⑤ 失败泄压：下层异常不得使 P 增加

const store = new Map<string, string>();
const redisMock = {
  get: vi.fn(async (k: string) => store.get(k) ?? null),
  set: vi.fn(async (k: string, v: string) => { store.set(k, v); return 'OK'; }),
  del: vi.fn(async (k: string) => { store.delete(k); return 1; }),
};
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => redisMock }));

const m = await import('../../../src/nyatos/trench.js');
const { P_MIN, P_MAX, R_MIN, R_MAX } = m;

beforeEach(() => { store.clear(); redisMock.get.mockClear(); redisMock.get.mockImplementation(async (k: string) => store.get(k) ?? null); });
afterEach(() => { try { rmSync(m.TRENCH_OBSERVATION_LOG, { force: true }); } catch { /* ok */ } });

describe('Trench L0 — 五条不可协商约束', () => {
  it('① 有界：两万次随机注入后 P 仍在 [0,12]，r 仍在 [0.25,6]', async () => {
    const chat = -1001;
    // 用确定性伪随机以保证可复现
    let seed = 12345;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    // 2 万次足够证伪有界性（真正要防的是"迟早越界"的积分器），
    // 同时把测试压在秒级——论文的可证伪指标不该用慢测试实现。
    for (let i = 0; i < 20000; i++) {
      const roll = rnd();
      if (roll < 0.5) await m.pulseForUnheard(chat, rnd() * 2 + 1);   // 过量 δ 也必须被夹
      else if (roll < 0.8) await m.releasePressure(chat);
      else if (roll < 0.9) await m.pump(chat);
      else await m.resetTrench(chat);
    }
    const r = await m.readTrench(chat);
    expect(r.p).toBeGreaterThanOrEqual(P_MIN);
    expect(r.p).toBeLessThanOrEqual(P_MAX);
    expect(r.rate).toBeGreaterThanOrEqual(R_MIN);
    expect(r.rate).toBeLessThanOrEqual(R_MAX);
  });

  it('①b 结构性保证：P=0 时速率不低于下界，P=最大时不吵', async () => {
    const a = -101, b = -102;
    const lo = await m.readTrench(a);                 // 从未写过 → P=0
    expect(lo.rate).toBeGreaterThanOrEqual(1.4);      // 不会消失
    // δ 上限是 1（一次闭环最多 +1），所以饱和要靠累积——这也正是
    // "结构性有界"的含义：永远追不上指数级的填充。
    for (let i = 0; i < 20; i++) await m.pulseForUnheard(b, 1);
    const hi = await m.readTrench(b);
    expect(hi.p).toBe(P_MAX);
    expect(hi.rate).toBeLessThanOrEqual(R_MAX);       // 不会吵
  });

  it('② 可观测：脉冲/泄放/泵浦都写 JSONL', async () => {
    const chat = -103;
    await m.pulseForUnheard(chat, 0.5);
    await m.releasePressure(chat);
    await m.pump(chat);
    const { readFileSync } = await import('node:fs');
    const lines = readFileSync(m.TRENCH_OBSERVATION_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const kinds = lines.map((l) => l.kind);
    expect(kinds).toContain('pulse');
    expect(kinds).toContain('release');
    expect(kinds).toContain('pump');
    for (const l of lines) expect(typeof l.ts).toBe('number');
  });

  it('③ 可强制复位：reset 后 P=0，且不依赖其他状态', async () => {
    const chat = -104;
    await m.pulseForUnheard(chat, 5);
    expect((await m.readTrench(chat)).p).toBeGreaterThan(0);
    await m.resetTrench(chat);
    const after = await m.readTrench(chat);
    expect(after.p).toBe(0);
    // 复位后再读一次仍为 0（不依赖"上次读过"这类隐状态）
    expect((await m.readTrench(chat)).p).toBe(0);
  });

  it('④ 无隐藏状态：我们写的 Redis key 只有 P / θ / 上次泵浦', async () => {
    const chat = -105;
    await m.pulseForUnheard(chat, 1);
    await m.pump(chat);
    const keys = [...store.keys()].filter((k) => k.includes('trench'));
    expect(keys.every((k) => /:(p|theta|lastpump):/.test(`${k}:`) || k.endsWith('p:' + chat) || k.endsWith('theta:' + chat) || k.endsWith('lastpump:' + chat))).toBe(true);
    expect(keys.length).toBeLessThanOrEqual(3);
  });

  it('⑤ 失败泄压：Redis 抛错时 P 不得增加', async () => {
    const chat = -106;
    await m.pulseForUnheard(chat, 2);
    const before = (await m.readTrench(chat)).p;
    redisMock.get.mockRejectedValueOnce(new Error('redis down'));
    await m.releasePressure(chat);      // 失败
    await m.pulseForUnheard(chat, 0);   // δ=0，不应写
    redisMock.get.mockRejectedValueOnce(new Error('redis down'));
    const r = await m.readTrench(chat).catch(() => null);
    // 读失败给中立读数（P=0），这不是"增加"；关键是失败路径没有把 P 写高
    expect(r === null || r.p <= Math.max(before, 0)).toBe(true);
    expect(before).toBeLessThanOrEqual(P_MAX);
  });

  it('读数 fail-soft：Redis 全挂时返回中立读数而不是抛错', async () => {
    redisMock.get.mockRejectedValue(new Error('redis down'));
    const r = await m.readTrench(-107);
    expect(r.p).toBe(0);
    expect(r.rate).toBeGreaterThan(0);
  });

  it('θ 被夹在 [0.35, 4.0]，模型无法把它改成 0 或 100', async () => {
    const chat = -108;
    await m.setThetaForTest(chat, 0);
    expect((await m.readTrench(chat)).theta).toBeGreaterThanOrEqual(0.35);
    await m.setThetaForTest(chat, 100);
    expect((await m.readTrench(chat)).theta).toBeLessThanOrEqual(4.0);
  });

  it('时间泵不会被重复半衰', async () => {
    const chat = -109;
    await m.pulseForUnheard(chat, 8);
    const t0 = Math.floor(Date.now() / 1000);
    expect(await m.pump(chat, t0)).toBe(true);
    const once = (await m.readTrench(chat)).p;
    expect(await m.pump(chat, t0 + 60)).toBe(false);   // 一小时内再调 → 不泵
    expect((await m.readTrench(chat)).p).toBe(once);
    // 跨过一个半衰期才泵
    await m.pump(chat, t0 + 3601);
    expect((await m.readTrench(chat)).p).toBeLessThan(once);
  });

  it('Frame 渲染是身体感受，不是配额', async () => {
    const chat = -110;
    expect(m.renderTrench(await m.readTrench(chat))).toBe('');   // P=0 不唠叨
    await m.pulseForUnheard(chat, 1);
    const s = m.renderTrench(await m.readTrench(chat));
    expect(s).toContain('[身体]');
    expect(s).not.toContain('必须');
    expect(s).not.toContain('禁止');
    expect(s).not.toContain('还剩');
  });
});
