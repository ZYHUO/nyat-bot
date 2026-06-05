import { describe, it, expect, beforeEach, vi } from 'vitest';

const envState = { TURN_FOCUS_ENABLED: true };

const hashes = new Map<string, Record<string, string>>();
const redisMock = {
  hgetall: vi.fn(async (k: string) => hashes.get(k) ?? {}),
  hset: vi.fn(async (k: string, ...args: string[]) => {
    const h = hashes.get(k) ?? {};
    for (let i = 0; i < args.length; i += 2) h[args[i]!] = args[i + 1]!;
    hashes.set(k, h);
    return 1;
  }),
  expire: vi.fn(async () => 1),
};

vi.mock('../../../src/env.js', () => ({ env: () => envState }));
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => redisMock }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import {
  getFocus,
  bumpFocus,
  debounceFactor,
  judgeReplyBar,
  followupProbability,
} from '../../../src/pipeline/turn/focus.js';

const CHAT = -100990;

beforeEach(() => {
  hashes.clear();
  redisMock.hgetall.mockClear();
  redisMock.hset.mockClear();
  envState.TURN_FOCUS_ENABLED = true;
});

describe('G9 focus scalar', () => {
  it('unknown chat sits at the baseline', async () => {
    expect(await getFocus(CHAT)).toBeCloseTo(0.3, 5);
  });

  it('events move focus and clamp to [0,1]', async () => {
    const afterSpoke = await bumpFocus(CHAT, 'bot_spoke');
    expect(afterSpoke).toBeCloseTo(0.55, 2);

    await bumpFocus(CHAT, 'direct_interaction');
    await bumpFocus(CHAT, 'direct_interaction');
    const high = await bumpFocus(CHAT, 'bot_spoke');
    expect(high).toBe(1); // clamped

    for (let i = 0; i < 12; i++) await bumpFocus(CHAT, 'gate_no_action');
    expect(await getFocus(CHAT)).toBe(0); // clamped low
  });

  it('decays toward the baseline with a 10min half-life', async () => {
    hashes.set(`xxb:turn:focus:${CHAT}`, {
      value: '0.9',
      at: String(Date.now() - 10 * 60 * 1000),
    });
    // 0.3 + (0.9-0.3)*0.5 = 0.6
    expect(await getFocus(CHAT)).toBeCloseTo(0.6, 2);
  });

  it('flag off → baseline, no redis traffic', async () => {
    envState.TURN_FOCUS_ENABLED = false;
    expect(await getFocus(CHAT)).toBeCloseTo(0.3, 5);
    expect(await bumpFocus(CHAT, 'bot_spoke')).toBeCloseTo(0.3, 5);
    expect(redisMock.hgetall).not.toHaveBeenCalled();
    expect(redisMock.hset).not.toHaveBeenCalled();
  });

  it('modulation curves behave at the extremes', () => {
    expect(debounceFactor(1)).toBeCloseTo(0.25, 5);
    expect(debounceFactor(0)).toBeCloseTo(1.75, 5);
    expect(judgeReplyBar(1)).toBeCloseTo(0.6, 5);
    expect(judgeReplyBar(0)).toBeCloseTo(0.8, 5);
    expect(followupProbability(1)).toBeCloseTo(0.45, 5);
    expect(followupProbability(0)).toBeCloseTo(0.15, 5);
  });
});
