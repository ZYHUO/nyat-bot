import { describe, expect, it } from 'vitest';
import { proposeActions } from '../../../../src/core/agenda/proposals.js';

// The structural problem this addresses: every proactive route used to key off the
// room being EMPTY (master silent >=4h, group cold >=2h, user absent >=3d). While
// humans were present and talking, no rule could fire at all — so autonomy only
// existed when nobody was watching.
//
// The new route keys off two things about the BOT instead of the room:
//   (1) it has an unacted own impulse  -> "I have something of my own to say"
//   (2) it has not spoken here for N   -> "I am not repeating myself"

const base = {
  world: {
    masterSilentSec: null as number | null,
    lastCareAgoSec: 0,
    groups: [] as Array<{ chatId: number; silentSec: number; lastTexts?: string; botSilentSec?: number }>,
    dueGoals: [] as Array<{ id: number; topic: string }>,
    rssNewCount: 0,
    absentUsers: [] as Array<{ chatId: number; uid: number; name: string; absentDays: number }>,
    selfPlayCooldownLeftSec: 999,
    lifeTransition: null as string | null,
  },
  masterConfigured: false,
};

describe('proposeActions — the self-initiated route', () => {
  it('fires on own impulse + own gap even when the room is BUSY', () => {
    const out = proposeActions({
      ...base,
      world: {
        ...base.world,
        groups: [{ chatId: -100, silentSec: 30, botSilentSec: 60 * 60 }], // 群很热闹
        unactedImpulses: [{ chatId: -100, about: '想问他换屏多少钱', minutesAgo: 4, verdict: 'speak' }],
      },
    });
    const speak = out.find((a) => a.type === 'group_speak');
    expect(speak).toBeTruthy();
    expect(speak).toMatchObject({ type: 'group_speak', chatId: -100 });
    // Its own reason travels with the candidate — the LLM is not told what to say.
    expect('about' in speak! && speak!.about).toBe('想问他换屏多少钱');
  });

  it('stays silent when it spoke recently (anti-repetition beats eagerness)', () => {
    const out = proposeActions({
      ...base,
      world: {
        ...base.world,
        groups: [{ chatId: -100, silentSec: 30, botSilentSec: 120 }], // 2 分钟前才说过
        unactedImpulses: [{ chatId: -100, about: '想问他换屏多少钱', minutesAgo: 4, verdict: 'speak' }],
      },
    });
    expect(out.some((a) => a.type === 'group_speak')).toBe(false);
  });

  it('records (not sends) when it has an impulse but is inside its own gap', () => {
    // busy room + recent own speech: neither the cold route nor the self route may speak
    const out = proposeActions({
      ...base,
      world: {
        ...base.world,
        // 房间正热闹（silentSec 小），所以冷场路由不可能触发；
        // 只有"我自己 2 分钟前才说过"挡住开口 → 应该转为记录
        groups: [{ chatId: -100, silentSec: 20, botSilentSec: 120 }],
        unactedImpulses: [{ chatId: -100, about: '刚才那事有点意思', minutesAgo: 2, verdict: 'speak' }],
      },
    });
    const note = out.find((a) => a.type === 'note_impulse');
    expect(note).toBeTruthy();
    expect(note).toMatchObject({ type: 'note_impulse', chatId: -100, about: '刚才那事有点意思' });
  });

  it('does not invent a route when it has nothing of its own', () => {
    const out = proposeActions({
      ...base,
      world: {
        ...base.world,
        groups: [{ chatId: -100, silentSec: 60, botSilentSec: 60 * 60 }],
        // no unactedImpulses at all
      },
    });
    expect(out.some((a) => a.type === 'group_speak' || a.type === 'note_impulse')).toBe(false);
    expect(out[out.length - 1]?.type).toBe('quiet');
  });

  it('keeps the cold-room route working (both routes coexist)', () => {
    const out = proposeActions({
      ...base,
      world: {
        ...base.world,
        groups: [{ chatId: -200, silentSec: 3 * 3600, botSilentSec: 10 * 60 }],
      },
    });
    expect(out).toContainEqual({ type: 'group_speak', chatId: -200 });
  });
});
