import { describe, expect, it, vi, beforeEach } from 'vitest';

// 确定性回填器的正确性直接决定整套"学习"是不是活的。
// 论文 §7.2 指标 3：现状 self_replies 98.7% 是 unknown，若这套不工作，
// E 永远停在 0.45、海沟退化成固定阈值 bot，而前两个 daily 指标会假装健康。

const dbMock = { prepare: vi.fn(() => ({ all: vi.fn(() => []), run: vi.fn(() => ({ changes: 1 })) })) };
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => dbMock }));

const store = new Map<string, string>();
const redisMock = {
  get: vi.fn(async (k: string) => store.get(k) ?? null),
  set: vi.fn(async (k: string, v: string) => { store.set(k, v); return 'OK'; },
  ),
};
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => redisMock }));

const envMock = { ECHO_ENABLED: true, BOT_USERNAME: 'hunhebi_bot', BOT_NICKNAMES: ['啾咪囝'] };
vi.mock('../../../src/env.js', () => ({ env: () => envMock }));

const closeSpy = vi.fn(() => true);
vi.mock('../../../src/tracking/self-history.js', () => ({ closeSelfActOutcome: (...a: unknown[]) => closeSpy(...a) }));

// 判据的数据源是 getRecent——和 pipeline 自己读的同一份
const recentMock = vi.fn(async () => [] as Array<Record<string, unknown>>);
vi.mock('../../../src/pipeline/context/manager.js', () => ({ getRecent: (...a: unknown[]) => recentMock(...a) }));

const m = await import('../../../src/agent/echo.js');

beforeEach(() => {
  store.clear();
  dbMock.prepare.mockClear();
  dbMock.prepare.mockImplementation(() => ({ all: vi.fn(() => []), run: vi.fn(() => ({ changes: 1 })) }));
  closeSpy.mockClear();
});

describe('Echo — 标量', () => {
  it('clamped to [0.05, 0.90] in both directions', async () => {
    // 50 次全接 → 必须停在 0.90，不许给免检
    for (let i = 0; i < 50; i++) await m.settleEcho(-100, 1);
    const hi = await m.readEcho(-100);
    expect(hi).toBeLessThanOrEqual(0.9);
    store.clear();
    // 50 次全无视 → 必须停在 0.05，不许归零（归零＝永久沉默）
    for (let i = 0; i < 50; i++) await m.settleEcho(-100, -0.5);
    const lo = await m.readEcho(-100);
    expect(lo).toBeGreaterThan(0);
    expect(lo).toBeGreaterThanOrEqual(0.05);
  });

  it('neutral read (not punishment) when the scalar is absent', async () => {
    expect(await m.readEcho(-999)).toBe(0.45);
  });

  it('被接住不脉冲，被无视才脉冲', async () => {
    await m.settleEcho(-100, 1);
    const pKey = 'xxb:trench:p:-100';
    expect(store.get(pKey)).toBeUndefined();      // 有人接 → 不给海床加压
    await m.settleEcho(-100, 0);
    expect(Number(store.get(pKey))).toBeGreaterThan(0); // 没人接 → 气压上涨
  });

  it('插砸了的脉冲强于单纯被无视', async () => {
    await m.settleEcho(-100, 0);
    const mild = Number(store.get('xxb:trench:p:-100'));
    store.clear();
    await m.settleEcho(-100, -0.5);
    const harsh = Number(store.get('xxb:trench:p:-100'));
    expect(harsh).toBeGreaterThan(mild);
  });

  it('渲染是身体感受，不是仪表读数', async () => {
    for (const e of [0.05, 0.3, 0.55, 0.85]) {
      const s = m.renderEcho(e);
      if (s) { expect(s).toContain('[回声]'); expect(s).not.toMatch(/0\.\d\d/); }
    }
  });

  it('所有低档位都必须带托底——"没人接"不等于"不该说"', () => {
    // 第一版只在最低档带托底。frame 测试在一个真实群（E≈0.3-0.5）上抓到中间档
    // '接的人不多' 没有任何托底——而那正是模型最可能解读成"我该闭嘴"的档位。
    for (const e of [0.05, 0.2, 0.35, 0.45]) {
      expect(m.renderEcho(e)).toContain('不代表不该说');
    }
    expect(m.renderEcho(0.8)).not.toContain('不代表不该说');
  });
});

describe('Echo — 确定性回填的判据', () => {
  const botTs = 1_000_000;
  const bot = { messageId: 555, role: 'assistant', timestamp: botTs, textContent: '我的发言' };
  const human = (mid: number, ts: number, text: string, replyTo?: unknown) =>
    ({ messageId: mid, role: 'user', timestamp: ts, textContent: text, ...(replyTo ? { replyTo } : {}) });

  function unsettledRow() {
    dbMock.prepare.mockImplementation((sql: string) =>
      sql.includes('FROM self_replies')
        ? { all: () => [{ id: 1, chat_id: -100, bot_message_id: 555, ts: botTs }], run: () => ({ changes: 1 }) }
        : { all: () => [], run: () => ({ changes: 0 }) });
  }

  it('观察窗内有人回复这一条 → replied', async () => {
    unsettledRow();
    recentMock.mockResolvedValueOnce([bot, human(900, botTs + 30, '确实', { messageId: 555, uid: 7 })]);
    expect(await m.backfillEcho()).toBe(1);
    expect(closeSpy).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'replied' }));
  });

  it('有人 @ bot → mentioned', async () => {
    unsettledRow();
    recentMock.mockResolvedValueOnce([bot, human(900, botTs + 30, '啾咪囝 你怎么看')]);
    expect(await m.backfillEcho()).toBe(1);
    expect(closeSpy).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'mentioned' }));
  });

  it('≥3 条人类消息且无人指向 bot → ignored', async () => {
    unsettledRow();
    recentMock.mockResolvedValueOnce([
      bot,
      human(1, botTs + 10, 'a'), human(2, botTs + 20, 'b'), human(3, botTs + 30, 'c'),
    ]);
    expect(await m.backfillEcho()).toBe(1);
    expect(closeSpy).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'ignored' }));
  });

  it('证据不足（才 1 条人类消息）不猜，留给下一轮', async () => {
    unsettledRow();
    recentMock.mockResolvedValueOnce([bot, human(1, botTs + 10, 'a')]);
    expect(await m.backfillEcho()).toBe(0);
    expect(closeSpy).not.toHaveBeenCalled();
  });

  it('我的发言已漫出上下文窗口 → 不猜（伪造"被无视"比不猜更糟）', async () => {
    unsettledRow();
    recentMock.mockResolvedValueOnce([human(1, 2, 'x'), human(2, 3, 'y')]); // 没有 mid=555
    expect(await m.backfillEcho()).toBe(0);
    expect(closeSpy).not.toHaveBeenCalled();
  });

  it('观察窗内静悄悄 → 证据不足，不判 ignored', async () => {
    unsettledRow();
    recentMock.mockResolvedValueOnce([bot]);
    expect(await m.backfillEcho()).toBe(0);
  });

  it('窗口外的后续消息不算数', async () => {
    unsettledRow();
    recentMock.mockResolvedValueOnce([
      bot,
      human(1, botTs + 10, 'a'), human(2, botTs + 20, 'b'),
      human(3, botTs + 4000, 'c'), // 远超观察窗
    ]);
    expect(await m.backfillEcho()).toBe(0);
  });

  it('还没过观察窗的行不碰', async () => {
    dbMock.prepare.mockImplementation((sql: string) =>
      sql.includes('FROM self_replies') ? { all: () => [], run: () => ({ changes: 0 }) } : { all: () => [], run: () => ({ changes: 0 }) });
    expect(await m.backfillEcho()).toBe(0);
  });

  it('flag 关时零动作', async () => {
    envMock.ECHO_ENABLED = false;
    expect(await m.backfillEcho()).toBe(0);
    envMock.ECHO_ENABLED = true;
  });

  it('DB 抛错不炸，返回 0', async () => {
    dbMock.prepare.mockImplementation(() => { throw new Error('no such table'); });
    expect(await m.backfillEcho()).toBe(0);
  });
});
