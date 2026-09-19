import { describe, expect, it, vi, beforeEach } from 'vitest';

// 这三个数是 10.1% 一致率的直接病因：决策点不知道自己刚叭叭了一堆没人理。
// 测试重点：**读数必须忠实**（算错比没有更糟），以及渲染必须是体感不是仪表盘。

const mine: Array<{ bot_message_id: number | null; outcome: string }> = [];
const totalN = { n: 0 };
vi.mock('../../../src/db/sqlite.js', () => ({
  getDb: () => ({
    prepare: (q: string) => ({
      all: () => (q.includes('self_replies') ? mine : []),
      get: () => (q.includes('message_received') ? totalN : { n: 0 }),
    }),
  }),
}));

const m = await import('../../../src/nyatos/self-state.js');
beforeEach(() => { mine.length = 0; totalN.n = 0; });

describe('readSelfState', () => {
  it('从没说过 → 不说话', () => {
    expect(m.readSelfState(-100)).toBeNull();
  });

  it('share30m = 我的条数 / 群总条数', () => {
    mine.push({ bot_message_id: 1, outcome: 'replied' }, { bot_message_id: 2, outcome: 'replied' });
    totalN.n = 8; // 2 mine + 8 humans
    const s = m.readSelfState(-100)!;
    expect(s.myRecentCount).toBe(2);
    expect(s.share30m).toBeCloseTo(2 / 10, 5);
  });

  it('unansweredStreak 从最新往回数，遇到有人接就停', () => {
    mine.push(
      { bot_message_id: 1, outcome: 'replied' },   // 最新：有人接 → 断在这儿
      { bot_message_id: 2, outcome: 'ignored' },
      { bot_message_id: 3, outcome: 'unknown' },
    );
    expect(m.readSelfState(-100)!.unansweredStreak).toBe(0);
  });

  it('连续 3 条 ignored → streak=3', () => {
    mine.push(
      { bot_message_id: 1, outcome: 'ignored' },
      { bot_message_id: 2, outcome: 'ignored' },
      { bot_message_id: 3, outcome: 'ignored' },
      { bot_message_id: 4, outcome: 'replied' },
    );
    expect(m.readSelfState(-100)!.unansweredStreak).toBe(3);
  });

  it('unknown 不算"没人接"——那是没去问，不是没人理', () => {
    mine.push(
      { bot_message_id: 1, outcome: 'unknown' },
      { bot_message_id: 2, outcome: 'unknown' },
      { bot_message_id: 3, outcome: 'ignored' },
    );
    // 第一条就是 unknown → 直接断，不许拿"没结算"冒充"被无视"
    expect(m.readSelfState(-100)!.unansweredStreak).toBe(0);
  });

  it('样本不足时 recentEcho=-1（别用 3 条数据下结论）', () => {
    mine.push({ bot_message_id: 1, outcome: 'replied' }, { bot_message_id: 2, outcome: 'ignored' });
    expect(m.readSelfState(-100)!.recentEcho).toBe(-1);
  });

  it('readSelfState 是纯读数：DB 抛错返回 null 而不是编一个', () => {
    expect(m.readSelfState(0)).toBeNull();
    expect(m.readSelfState(NaN)).toBeNull();
  });
});

describe('renderSelfState', () => {
  it('本条数=0 不渲染', () => {
    expect(m.renderSelfState({ share30m: 0, myRecentCount: 0, unansweredStreak: 0, recentEcho: -1 })).toBe('');
  });

  it('一切正常不唠叨', () => {
    expect(m.renderSelfState({ share30m: 0.1, myRecentCount: 2, unansweredStreak: 0, recentEcho: 0.9 })).toBe('');
  });

  it('说得多 + 没人接 → 一次说清，且是体感不是仪表盘', () => {
    const s = m.renderSelfState({ share30m: 0.55, myRecentCount: 6, unansweredStreak: 3, recentEcho: 0.1 });
    expect(s).toContain('[你自已]');
    expect(s).toContain('几乎都是你在说');
    expect(s).toContain('连着 3 条都没人接');
    expect(s).not.toMatch(/0\.\d\d|%/); // 不出现数字仪表
    expect(s).not.toContain('禁止');
  });
});
