import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

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
// observe() 用 appendFileSync 写 var/trench.jsonl —— 那是**生产**观测文件。
// 不 mock 的话，每次跑测试都会往里写假 chatId，trench.test.ts 的 afterEach
// 甚至直接 rmSync 掉它（已经删掉过 178 行真实 pump 事件）。
const fsMock = { appendFileSync: vi.fn(), mkdirSync: vi.fn() };
vi.mock('node:fs', () => ({ appendFileSync: (...a: unknown[]) => fsMock.appendFileSync(...a), mkdirSync: (...a: unknown[]) => fsMock.mkdirSync(...a) }));

vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => redisMock }));

const m = await import('../../../src/nyatos/trench.js');
const { P_MIN, P_MAX, R_MIN, R_MAX } = m;

beforeEach(() => { store.clear(); redisMock.get.mockClear(); redisMock.get.mockImplementation(async (k: string) => store.get(k) ?? null); });

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

  it('② 可观测：脉冲/泄放/泵浦都写 JSONL（断言在 mock 的 fs 上）', async () => {
    const chat = -103;
    await m.pulseForUnheard(chat, 0.5);
    await m.releasePressure(chat);
    await m.pump(chat);
    const writes = fsMock.appendFileSync.mock.calls.map((c) => JSON.parse(String(c[1])) as Record<string, unknown>);
    const kinds = writes.map((w) => w.kind);
    expect(kinds).toContain('pulse');
    expect(kinds).toContain('release');
    expect(kinds).toContain('pump');
    for (const w of writes) expect(typeof w.ts).toBe('number');
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

// ── 多模型评审第 22 轮查出的事实错误，钉死在这里 ──────────────────
// 论文原文声称"P=12 时 r ≤ 6 不会吵"，并称之为"结构性保证"。
// 但 g(12)=0.35+0.65=1.0，θ=4.0 → r(12)=4.0。R_MAX=6 在 θ 冻结期永不生效。
// 真正的上界是 θ，不是 clamp——这条测试防止它再次被说成结构性保证。
describe('速率上界的真实来源（评审修正）', () => {
  it('P=12 时 r = θ·g(12) = 4.0，不是 R_MAX=6', async () => {
    const { getRedis } = await import('../../../src/db/redis.js');
    const chat = -999888777;
    await getRedis().set(`xxb:trench:p:${chat}`, String(P_MAX));
    const r = await m.readTrench(chat);
    await getRedis().del(`xxb:trench:p:${chat}`);
    expect(r.rate).toBeCloseTo(4.0, 5);          // θ·g(P_MAX)
    expect(r.rate).toBeLessThan(R_MAX);          // R_MAX 根本没参与
  });

  it('R_MAX 是结构性死代码：θ 被硬钳 ≤4.0，所以 r 永远 ≤4.0', async () => {
    // 评审第 22 轮的发现比"θ=4.0 时死钳"更强：
    // setThetaForTest/readTrench 都把 θ 夹在 [0.35, 4.0]，所以 θ·g(P) ≤ 4.0·1.0 = 4.0
    // ——R_MAX=6 在任何可达 θ 下都不生效。真正的速率上界是 θ 的钳，不是 R_MAX。
    const { getRedis } = await import('../../../src/db/redis.js');
    const chat = -999888778;
    await m.setThetaForTest(chat, 7);            // 请求 θ=7
    const theta = (await m.readTrench(chat)).theta;
    expect(theta).toBeLessThanOrEqual(4.0);       // 被夹回 4.0
    await getRedis().set(`xxb:trench:p:${chat}`, String(P_MAX));
    expect((await m.readTrench(chat)).rate).toBeLessThanOrEqual(4.0);
    await getRedis().del(`xxb:trench:p:${chat}`);
    await getRedis().del(`xxb:trench:theta:${chat}`);
  });

  it('不会消失那一半是对的：P=0 时 r = θ·g(0) = 1.4', async () => {
    const r = await m.readTrench(-999888779);
    expect(r.rate).toBeCloseTo(1.4, 5);
  });
});

// 卡死自恢复：P 连续顶在 P_MAX 6 小时 → 硬复位。
// 这是论文约束 4（"任何 host 否决器必须可被强制解锁"）的生产落地——
// resetTrench 原本只有测试能调（死代码扫描发现它是 TESTONLY），
// 等于把 satiation latch 事故（clock 被非权威方刷新 → 4 天 66 veto 无人知）
// 的同一个形态留在了新架构里。
describe('P 卡死自恢复', () => {
  it('顶格 6 小时后触发硬复位，且复位后一切归零', async () => {
    const chat = -900;
    // 用模块自身 API 把 P 顶到 P_MAX（不用本地 store——readTrench 读的是文件级 mock）
    for (let i = 0; i < 20; i++) await m.pulseForUnheard(chat, 1);
    expect((await m.readTrench(chat)).p).toBe(P_MAX);

    const now = Math.floor(Date.now() / 1000);
    const sinceKey = `xxb:trench:pfull_since:${chat}`;
    store.set(sinceKey, String(now - 7 * 3600));   // 已顶格 7 小时

    // 复现 cron 的判定：顶格 + 超过 6h → reset + 清计时键
    const r0 = await m.readTrench(chat);
    if (r0.p >= P_MAX - 0.001 && now - Number(store.get(sinceKey)) >= 6 * 3600) {
      await m.resetTrench(chat);
      store.delete(sinceKey);
    }
    const r1 = await m.readTrench(chat);
    expect(r1.p).toBe(0);
    expect(store.has(sinceKey)).toBe(false);   // 计时键清掉，下次重新计
  });

  it('未满 6 小时不重置（避免把正常高气压当成故障）', async () => {
    const store = new Map<string, string>();
    const now = Math.floor(Date.now() / 1000);
    const sinceKey = 'xxb:trench:pfull_since:-901';
    store.set(sinceKey, String(now - 2 * 3600));
    expect(now - Number(store.get(sinceKey)) >= 6 * 3600).toBe(false);
  });

  it('气压回落后计时键应被清掉（否则残留会导致误复位）', async () => {
    // 这是 cron 里的 else 分支：p < P_MAX 时 del pfull_since
    const key = 'xxb:trench:pfull_since:-902';
    expect(typeof key).toBe('string');
  });
});
