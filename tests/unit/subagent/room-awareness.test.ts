import { describe, expect, it, vi } from 'vitest';

// 房间感知注入：把 frame 已经算好的信号喂进 CodeAct 任务 prompt。
// 价值主张来自 2026-09-19 真人对比：bot 每句话都锚在"上一条消息"上，
// 从不"参与圈子"；而真人会主动贡献、讲自己的事、看圈子在聊什么。

const envMock = { ROOM_AWARENESS_ENABLED: true };
vi.mock('../../../src/env.js', () => ({ env: () => envMock }));

vi.mock('../../../src/nyatos/frame.js', () => ({
  buildFrame: vi.fn(async () => ({
    schema: 'frame.v1',
    scope: { visibility: 'chat', chatId: -1002943259956 },
    asOf: 0,
    identity: { uid: 1, username: 'x', displayName: '啾咪囝' },
    clock: { nowIso: '2026-09-19T05:00:00Z', weekday: '周六', triggerAgeSec: 12, sinceBotSpokeSec: 900 },
    field: { talkers: 3, addressee: 'bot', mood: '吵' },
    inner: null,
    capability: null,
    self: { recentActs: [], openThreads: '昨天说要告诉他冷处理' },
    addressedToOthers: { handle: '@someone_else' },
    recentLines: [],
    unknowns: [],
  })),
  renderFrame: vi.fn(() => '[现在] 2026-09-19 05:00 周六 · 这条消息 刚刚\n[圈子] 3 个人在说，正跟我说话'),
}));

vi.mock('../../../src/bot/bot.js', () => ({
  getBotIdentity: () => ({ uid: 8392759490, username: 'hunhebi_bot', displayName: '啾咪囝', nicknames: [] }),
  getBotDisplayName: () => '啾咪囝',
  getBotUid: () => 8392759490,
}));

vi.mock('../../../src/tracking/self-history.js', () => ({
  getRecentBotTextsInChat: vi.fn(() => [
    '已举报，等踢喵',
    '谁看了啊笨',
    '叫妈也没用，本喵又不是 ATM 喵',
    '想得挺美，本喵的钱是大风刮来的喵',
    '那快开啊，别硬扛',
  ]),
}));

const { renderRoomAwareness } = await import('../../../src/subagent/room-awareness.js');

describe('renderRoomAwareness', () => {
  it('renders the frame into an injectable prompt block', async () => {
    const r = await renderRoomAwareness({ chatId: -1002943259956, botUid: 8392759490 });
    expect(r.text).toContain('[这个房间现在什么样]');
    expect(r.text).toContain('[圈子] 3 个人在说');
    // It must tell the model what the block is FOR, or it becomes noise.
    expect(r.text).toContain('现在该不该说');
    expect(r.text).toContain('不要');
  });

  it('reports which signals were available (observability)', async () => {
    const r = await renderRoomAwareness({ chatId: -1002943259956, botUid: 8392759490 });
    expect(r.signals).toContain('field');
    expect(r.signals).toContain('threads');
    expect(r.signals).toContain('addressed_to_others');
  });

  it('does nothing when the flag is off (zero side effects)', async () => {
    envMock.ROOM_AWARENESS_ENABLED = false;
    const r = await renderRoomAwareness({ chatId: -1002943259956, botUid: 8392759490 });
    expect(r.text).toBe('');
    expect(r.signals).toEqual([]);
    envMock.ROOM_AWARENESS_ENABLED = true;
  });

  it('surfaces the bot own 喵-tail rate as a FACT, not a quota', async () => {
    const r = await renderRoomAwareness({ chatId: -1002943259956, botUid: 8392759490 });
    expect(r.text).toContain('你自已的毛病');
    expect(r.text).toContain('拿"喵"收尾');
    // The whole point: the model decides. No hard trimming, no refusal.
    expect(r.signals).toContain('self_stats');
    expect(r.text).not.toContain('禁止');
    expect(r.text).not.toContain('必须');
    expect(r.text).toContain('你自己决定');
  });

  it('stays quiet about 喵 when the rate is already natural', async () => {
    const mod = await import('../../../src/tracking/self-history.js');
    (mod.getRecentBotTextsInChat as unknown as { mockReturnValueOnce: (v: unknown) => void })
      .mockReturnValueOnce(['那快开啊，别硬扛', '谁看了啊笨', '想得挺美', '别瞎脑补', '路过而已']);
    const r = await renderRoomAwareness({ chatId: -1002943259956, botUid: 8392759490 });
    expect(r.text).not.toContain('你自已的毛病');
  });

  it('fails soft when the frame cannot be built', async () => {
    const frameMod = await import('../../../src/nyatos/frame.js');
    (frameMod.buildFrame as unknown as { mockRejectedValueOnce: (e: unknown) => void })
      .mockRejectedValueOnce(new Error('qdrant down'));
    const r = await renderRoomAwareness({ chatId: -1002943259956, botUid: 8392759490 });
    // Unavailable awareness must never break the task — just skip the injection.
    expect(r.text).toBe('');
    expect(r.signals).toEqual([]);
  });
});
