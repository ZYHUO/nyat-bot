import { describe, it, expect } from 'vitest';

import { proposeActions, formatProposals } from '../../../../src/core/agenda/proposals.js';
import { scoreAction, deriveDriveValues } from '../../../../src/core/drives/score.js';

const baseWorld = {
  masterSilentSec: null as number | null,
  lastCareAgoSec: 60,
  groups: [{ chatId: -100, silentSec: 60 }],
  dueGoals: [] as { id: number; topic: string }[],
  rssNewCount: 0,
  absentUsers: [] as { chatId: number; uid: number; name: string; absentDays: number }[],
  selfPlayCooldownLeftSec: 9999,
  lifeTransition: null,
};

describe('agenda proposals', () => {
  it('空世界 → 只有 quiet', () => {
    const out = proposeActions({ world: baseWorld, masterConfigured: true });
    expect(out).toEqual([{ type: 'quiet' }]);
  });

  it('主人沉默 ≥4h → care_master', () => {
    const out = proposeActions({
      world: { ...baseWorld, masterSilentSec: 5 * 3600 },
      masterConfigured: true,
    });
    expect(out.some((a) => a.type === 'care_master')).toBe(true);
  });

  it('主人未配置 → 不提 care_master/self_play', () => {
    const out = proposeActions({
      world: { ...baseWorld, masterSilentSec: 9 * 3600, selfPlayCooldownLeftSec: 0 },
      masterConfigured: false,
    });
    expect(out.some((a) => a.type === 'care_master')).toBe(false);
    expect(out.some((a) => a.type === 'self_play')).toBe(false);
  });

  it('群冷场 ≥2h → group_speak（取最冷的）', () => {
    const out = proposeActions({
      world: {
        ...baseWorld,
        groups: [
          { chatId: -100, silentSec: 3 * 3600 },
          { chatId: -200, silentSec: 5 * 3600 },
        ],
      },
      masterConfigured: true,
    });
    const gs = out.find((a) => a.type === 'group_speak');
    expect(gs).toEqual({ type: 'group_speak', chatId: -200 });
  });

  it('到期 goal → check_goal；缺席熟人 → remember_user', () => {
    const out = proposeActions({
      world: {
        ...baseWorld,
        dueGoals: [{ id: 7, topic: 't' }],
        absentUsers: [{ chatId: -100, uid: 1, name: 'bob', absentDays: 5 }],
      },
      masterConfigured: true,
    });
    expect(out.some((a) => a.type === 'check_goal')).toBe(true);
    expect(out.some((a) => a.type === 'remember_user')).toBe(true);
  });

  it('formatProposals 按增益排序可读', () => {
    const values = deriveDriveValues({
      ...baseWorld,
      masterSilentSec: 8 * 3600,
      lastCareAgoSec: 30 * 3600,
    });
    const actions = proposeActions({
      world: { ...baseWorld, masterSilentSec: 8 * 3600, lastCareAgoSec: 30 * 3600 },
      masterConfigured: true,
    });
    const scores = new Map(actions.map((a) => [JSON.stringify(a), scoreAction(a, values)]));
    const text = formatProposals(actions, scores);
    expect(text).toContain('care_master');
    expect(text).toContain('drive增益');
  });
});
