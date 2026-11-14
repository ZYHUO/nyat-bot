import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Before this change the bot had NO way to schedule its own future thinking:
// scheduleSelfWake() and listDueSelfWakes() existed in cognitive-clock.ts with
// zero callers and zero rows in the ledger. The writer and the reader were both
// built; neither was attached to anything.

const sched = vi.fn(() => ({ inserted: true, eventId: 'e1', wakeAt: 12345 }));
const due = vi.fn(() => [
  { about: '回去看看他试了没', wakeAt: 12300, scope: { visibility: 'chat' as const, chatId: -100 } },
]);
const envMock = { ROOM_AWARENESS_ENABLED: true };
vi.mock('../../../src/env.js', () => ({ env: () => envMock }));
vi.mock('../../../src/nyatos/frame.js', () => ({
  buildFrame: vi.fn(async () => ({ self: {}, field: null, inner: null })),
  renderFrame: vi.fn(() => '[现在] 测试房间'),
}));
vi.mock('../../../src/bot/bot.js', () => ({
  getBotIdentity: () => ({ uid: 1, username: 'test_bot', displayName: '测试喵', nicknames: [] }),
  getBotDisplayName: () => '测试喵',
}));
vi.mock('../../../src/tracking/self-history.js', () => ({ getRecentBotTextsInChat: () => [] }));
vi.mock('../../../src/agent/cognitive-clock.js', () => ({
  scheduleSelfWake: (...a: unknown[]) => sched(...a),
  listDueSelfWakes: (...a: unknown[]) => due(...a),
}));

const { renderRoomAwareness } = await import('../../../src/subagent/room-awareness.js');

describe('self-wake: the bot scheduling its own future', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    envMock.ROOM_AWARENESS_ENABLED = true;
    due.mockReset().mockReturnValue([
      { about: '回去看看他试了没', wakeAt: 12300, scope: { visibility: 'chat' as const, chatId: -100 } },
    ]);
  });
  afterEach(() => { envMock.ROOM_AWARENESS_ENABLED = true; });

  it('surfaces due self-wakes as its own commitment coming back', async () => {
    const r = await renderRoomAwareness({ chatId: -100, botUid: 1 });
    expect(r.text).toContain('[你约过自己的事]');
    expect(r.text).toContain('回去看看他试了没');
    // It must be allowed to let it go — not a nagging obligation.
    expect(r.text).toContain('不用勉强');
    expect(r.signals).toContain('self_wakes:1');
    expect(due).toHaveBeenCalledWith({ visibility: 'chat', chatId: -100 }, expect.any(Number), 3);
  });

  it('says nothing when nothing is due', async () => {
    due.mockReturnValueOnce([]);
    const r = await renderRoomAwareness({ chatId: -100, botUid: 1 });
    expect(r.text).not.toContain('[你约过自己的事]');
  });

  it('does not read self-wakes or build the frame when room awareness is disabled', async () => {
    envMock.ROOM_AWARENESS_ENABLED = false;
    const r = await renderRoomAwareness({ chatId: -100, botUid: 1 });
    expect(r).toEqual({ text: '', signals: [] });
    expect(due).not.toHaveBeenCalled();
    const { buildFrame } = await import('../../../src/nyatos/frame.js');
    expect(buildFrame).not.toHaveBeenCalled();
  });

  it('honors an explicit per-call self-wake opt-out', async () => {
    const r = await renderRoomAwareness({ chatId: -100, botUid: 1, withSelfWakes: false });
    expect(r.text).not.toContain('[你约过自己的事]');
    expect(due).not.toHaveBeenCalled();
  });
});
