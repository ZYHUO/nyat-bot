import { describe, it, expect } from 'vitest';
import { shouldStaySilent } from '../../../src/pipeline/rhythm/silence.js';

function tsAgo(secAgo: number[]): number[] {
  const now = Math.floor(Date.now() / 1000);
  return secAgo.map((s) => now - s).sort((a, b) => a - b);
}

describe('shouldStaySilent', () => {
  it('bot just spoke (<60s) + nobody followed → silent (no self-chase)', () => {
    const now = Math.floor(Date.now() / 1000);
    const r = shouldStaySilent({
      lastBotReplyAtMs: now * 1000 - 30_000,
      recentMessages: [],
      botUid: 9999,
      nowMs: now * 1000,
    });
    expect(r.silent).toBe(true);
    expect(r.reason).toBe('self_chase');
  });

  it('bot spoke + human followed → not silent', () => {
    const now = Math.floor(Date.now() / 1000);
    const r = shouldStaySilent({
      lastBotReplyAtMs: now * 1000 - 30_000,
      recentMessages: [
        { uid: 1001, timestamp: now - 10 } as never,
      ],
      botUid: 9999,
      nowMs: now * 1000,
    });
    expect(r.silent).toBe(false);
  });

  it('hot chat + not addressed → silent (lurk)', () => {
    const r = shouldStaySilent({
      recentMessages: [],
      botUid: 9999,
      nowMs: Date.now(),
      messagesLast1Min: 15,
      addressedToBot: false,
    });
    expect(r.silent).toBe(true);
    expect(r.reason).toBe('hot_lurk');
  });

  it('hot chat + addressed → not silent', () => {
    const r = shouldStaySilent({
      recentMessages: [],
      botUid: 9999,
      nowMs: Date.now(),
      messagesLast1Min: 15,
      addressedToBot: true,
    });
    expect(r.silent).toBe(false);
  });

  it('nobody talked for 6h + not addressed → silent (no grave-digging)', () => {
    const r = shouldStaySilent({
      recentMessages: tsAgo([6 * 3600 + 60]).map((t) => ({ uid: 1001, timestamp: t }) as never),
      botUid: 9999,
      nowMs: Date.now(),
    });
    expect(r.silent).toBe(true);
    expect(r.reason).toBe('dead_chat');
  });

  it('calm chat + addressed → not silent', () => {
    const r = shouldStaySilent({
      recentMessages: [],
      botUid: 9999,
      nowMs: Date.now(),
      messagesLast1Min: 2,
      addressedToBot: true,
    });
    expect(r.silent).toBe(false);
  });

  it('no data → not silent (fail-open)', () => {
    const r = shouldStaySilent({ recentMessages: [], botUid: 9999, nowMs: Date.now() });
    expect(r.silent).toBe(false);
  });
});
