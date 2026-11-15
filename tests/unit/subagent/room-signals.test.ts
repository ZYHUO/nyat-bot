import { describe, expect, it, vi, beforeEach } from 'vitest';

// room-awareness 的 signals 清单是"注入了什么"的唯一可观测出口。
// 2026-09-19：它只报 field/inner/self_stats，而我新加的身体事实一段都不报——
// 于是"生产已注入 639 次、606 字"根本证明不了它们真的进了 prompt。
// 会话里已经错过三次"填了没渲染"，可观测性不能再缺同一环。

const frameNow = {
  field: { topic: 'x' },
  inner: {},
  self: {
    recentActs: [],
    trench: { chatId: -1, p: 2, theta: 4, rate: 2, urge: 0.2 },
    selfState: '[你自已] 你说得不少。',
    debt: '[欠话] 欠 2 句。',
    echo: '[回声] 接的人不多——但这不代表不该说。',
    recentImpulses: [{ minutesAgo: 1, verdict: 'speak', why: '想接话' }],
  },
  recentLines: ['- 用户: 你好'],
};

vi.mock('../../../src/env.js', () => ({ env: () => ({ ROOM_AWARENESS_ENABLED: true }) }));
vi.mock('../../../src/nyatos/frame.js', () => ({
  buildFrame: async () => frameNow,
  renderFrame: () => 'RENDERED-FRAME',
}));
vi.mock('../../../src/bot/bot.js', () => ({
  getBotUid: () => 1,
  getBotIdentity: () => ({ username: 'b', nicknames: [] }),
  getBotDisplayName: () => '啾咪囝',
}));
vi.mock('../../../src/tracking/self-history.js', () => ({
  getRecentBotTextsInChat: () => ['你好喵', '在吗喵', '来啦喵', '好的喵'],
  ownSpeechStats: () => ({ total: 3, mao: 1 }),
}));
vi.mock('../../../src/tracking/sleep.js', () => ({ getSleepPhase: async () => 'awake' }));
vi.mock('../../../src/nyatos/trench.js', () => ({ readTrench: async () => ({ p: 0 }) }));

const m = await import('../../../src/subagent/room-awareness.js');
beforeEach(() => { vi.clearAllMocks(); });

describe('room-awareness signals 覆盖身体事实', () => {
  it('五段身体事实都出现在 signals 里', async () => {
    const r = await m.renderRoomAwareness({
      chatId: -100,
      botUid: 1,
      quoteMessageId: 1,
      recentBotTexts: ['你好喵', '在吗喵', '来啦喵', '好的喵'],
    });
    // room-awareness 会加一段头（"以下是你的处境感知"），所以是包含而非相等
    expect(r.text).toContain('RENDERED-FRAME');
    expect(r.text).toContain('处境感知');
    for (const s of ['field', 'inner', 'self_stats', 'trench', 'self_state', 'debt', 'echo', 'impulses']) {
      expect(r.signals, `缺少 ${s}`).toContain(s);
    }
  });

  it('某段缺失时 signals 不报它（不然信号就是假的）', async () => {
    const saved = frameNow.self.echo;
    delete (frameNow.self as { echo?: string }).echo;
    const r = await m.renderRoomAwareness({ chatId: -100, botUid: 1, quoteMessageId: 1, recentBotTexts: ['x'] });
    expect(r.signals).not.toContain('echo');
    (frameNow.self as { echo?: string }).echo = saved;
  });

  it('impulses 为空数组时不报', async () => {
    const saved = frameNow.self.recentImpulses;
    frameNow.self.recentImpulses = [];
    const r = await m.renderRoomAwareness({ chatId: -100, botUid: 1, quoteMessageId: 1, recentBotTexts: ['x'] });
    expect(r.signals).not.toContain('impulses');
    frameNow.self.recentImpulses = saved;
  });
});
