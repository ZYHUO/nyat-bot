import { describe, expect, it, vi } from 'vitest';

// Before this change the bot had NO way to schedule its own future thinking:
// scheduleSelfWake() and listDueSelfWakes() existed in cognitive-clock.ts with
// zero callers and zero rows in the ledger. The writer and the reader were both
// built; neither was attached to anything.

const sched = vi.fn(() => ({ inserted: true, eventId: 'e1', wakeAt: 12345 }));
const due = vi.fn(() => [
  { about: '回去看看他试了没', wakeAt: 12300, scope: { visibility: 'chat' as const, chatId: -100 } },
]);
vi.mock('../../../src/agent/cognitive-clock.js', () => ({
  scheduleSelfWake: (...a: unknown[]) => sched(...a),
  listDueSelfWakes: (...a: unknown[]) => due(...a),
}));

const { renderRoomAwareness } = await import('../../../src/subagent/room-awareness.js');

describe('self-wake: the bot scheduling its own future', () => {
  it('surfaces due self-wakes as its own commitment coming back', async () => {
    const r = await renderRoomAwareness({ chatId: -100, botUid: 1 });
    expect(r.text).toContain('[你约过自己的事]');
    expect(r.text).toContain('回去看看他试了没');
    // It must be allowed to let it go — not a nagging obligation.
    expect(r.text).toContain('不用勉强');
    expect(r.signals).toContain('self_wakes:1');
  });

  it('says nothing when nothing is due', async () => {
    due.mockReturnValueOnce([]);
    const r = await renderRoomAwareness({ chatId: -100, botUid: 1 });
    expect(r.text).not.toContain('[你约过自己的事]');
  });
});
