import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FormattedMessage } from '../../../src/shared/types.js';

const state = vi.hoisted(() => ({ epoch: 100 as number | undefined, getGroupMembers: vi.fn() }));
vi.mock('../../../src/env.js', () => ({ env: () => ({ PROACTIVE_ACTIVATED_AT_SEC: state.epoch }) }));
vi.mock('../../../src/pipeline/context/manager.js', () => ({ getGroupMembers: state.getGroupMembers }));

import {
  checkProactiveActivation,
  evaluateProactiveActivation,
  lastHumanMessageAtSec,
} from '../../../src/cron/activation-policy.js';

function message(overrides: Partial<FormattedMessage> = {}): FormattedMessage {
  return {
    role: 'user', uid: 42, username: 'human', fullName: 'Human', timestamp: 101,
    messageId: 1, textContent: 'hello', isForwarded: false, ...overrides,
  };
}

beforeEach(() => {
  state.epoch = 100;
  state.getGroupMembers.mockReset().mockResolvedValue([]);
});

describe('proactive migration activation', () => {
  it('keeps existing deployments unchanged when epoch is zero without reading activity', async () => {
    state.epoch = 0;
    expect(await checkProactiveActivation(-1, { nowSec: 200 })).toEqual({
      allowed: true, reason: 'disabled', lastHumanAtSec: null,
    });
    expect(state.getGroupMembers).not.toHaveBeenCalled();
  });

  it('keeps old callers and partial env mocks compatible when the new field is absent', async () => {
    state.epoch = undefined;
    expect((await checkProactiveActivation(-1, { nowSec: 200 })).reason).toBe('disabled');
    expect(state.getGroupMembers).not.toHaveBeenCalled();
  });

  it('does not activate a restored chat from old or exact-boundary history', async () => {
    state.getGroupMembers.mockResolvedValue([{ uid: 42, lastSeen: 99 }]);
    const result = await checkProactiveActivation(-1, {
      nowSec: 200, recentMessages: [message({ timestamp: 100 })],
    });
    expect(result.allowed).toBe(false);
    expect(result.lastHumanAtSec).toBe(100);
  });

  it('rejects assistant, system, bot and anonymous context rows', async () => {
    const result = await checkProactiveActivation(-1, {
      nowSec: 200,
      recentMessages: [
        message({ role: 'assistant' }), message({ role: 'system' }),
        message({ isBot: true }), message({ isAnonymous: true }),
        message({ uid: 1087968824 }), message({ uid: 0 }), message({ uid: -1 }),
      ],
    });
    expect(result).toEqual({ allowed: false, reason: 'no_human_after_activation', lastHumanAtSec: null });
  });

  it('allows a real new message using its original timestamp and skips extra storage reads', async () => {
    const result = await checkProactiveActivation(-1, { nowSec: 200, recentMessages: [message()] });
    expect(result).toEqual({ allowed: true, reason: 'human_after_activation', lastHumanAtSec: 101 });
    expect(state.getGroupMembers).not.toHaveBeenCalled();
  });

  it('uses human membership to cover other forum topics and positive-ID DMs', async () => {
    state.getGroupMembers.mockResolvedValue([{ uid: 42, lastSeen: 150 }]);
    expect((await checkProactiveActivation(42, { nowSec: 200 })).allowed).toBe(true);
    expect(state.getGroupMembers).toHaveBeenCalledWith(42);
  });

  it('does not treat receipt of a replayed old message as new human activity', async () => {
    state.getGroupMembers.mockResolvedValue([{ uid: 42, lastSeen: 50 }]);
    const result = await checkProactiveActivation(-1, { nowSec: 200, recentMessages: [message({ timestamp: 50 })] });
    expect(result.allowed).toBe(false);
    expect(result.lastHumanAtSec).toBe(50);
  });

  it('fails closed when the activity store is unavailable', async () => {
    state.getGroupMembers.mockRejectedValue(new Error('offline'));
    expect(await checkProactiveActivation(-1, { nowSec: 200 })).toEqual({
      allowed: false, reason: 'activity_unavailable', lastHumanAtSec: null,
    });
  });

  it('does not activate from future, malformed or millisecond timestamps', async () => {
    state.getGroupMembers.mockResolvedValue([
      { uid: 42, lastSeen: 201 }, { uid: 43, lastSeen: '150' },
      { uid: 44, lastSeen: 150000 }, { uid: 0, lastSeen: 150 },
    ]);
    expect((await checkProactiveActivation(-1, { nowSec: 200 })).allowed).toBe(false);
    expect(lastHumanMessageAtSec([message({ timestamp: Number.NaN }), message({ timestamp: 201 })], 200)).toBeNull();
  });

  it('rejects invalid or future activation epochs', () => {
    for (const epoch of [-1, Number.NaN, Number.POSITIVE_INFINITY, 201, 100.5]) {
      expect(evaluateProactiveActivation(epoch, 150, 200).reason).toBe('invalid_activation_epoch');
    }
  });

  it('finds the latest original human timestamp independently of row order', () => {
    expect(lastHumanMessageAtSec([
      message({ timestamp: 180 }), message({ timestamp: 190, role: 'assistant' }), message({ timestamp: 120 }),
    ], 200)).toBe(180);
  });
});
