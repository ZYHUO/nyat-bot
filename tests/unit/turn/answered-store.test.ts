import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { FormattedMessage } from '../../../src/shared/types.js';

// In-memory sorted-set mock
const zsets = new Map<string, Map<string, number>>();

const redisMock = {
  zadd: vi.fn(async (k: string, ...args: Array<string | number>) => {
    const z = zsets.get(k) ?? new Map<string, number>();
    for (let i = 0; i < args.length; i += 2) {
      z.set(String(args[i + 1]), Number(args[i]));
    }
    zsets.set(k, z);
    return 1;
  }),
  zremrangebyscore: vi.fn(async (k: string, min: number, max: number) => {
    const z = zsets.get(k);
    if (!z) return 0;
    let n = 0;
    for (const [member, score] of z) {
      if (score >= min && score <= max) {
        z.delete(member);
        n++;
      }
    }
    return n;
  }),
  zmscore: vi.fn(async (k: string, ...members: string[]) => {
    const z = zsets.get(k);
    return members.map((m) => (z?.has(m) ? String(z.get(m)) : null));
  }),
  expire: vi.fn(async () => 1),
  multi: () => {
    const ops: Array<() => Promise<unknown>> = [];
    const m: Record<string, unknown> = {};
    for (const name of ['zadd', 'zremrangebyscore', 'expire'] as const) {
      m[name] = (...args: unknown[]) => {
        ops.push(() => (redisMock as Record<string, (...a: unknown[]) => Promise<unknown>>)[name]!(...args));
        return m;
      };
    }
    m['exec'] = async () => {
      const out: Array<[null, unknown]> = [];
      for (const op of ops) out.push([null, await op()]);
      return out;
    };
    return m;
  },
};

vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => redisMock }));

import { markAnswered, pickRevisitCandidates } from '../../../src/pipeline/turn/answered-store.js';

const CHAT = -100900;
const BOT_UID = 9999;

function msg(messageId: number, over: Partial<FormattedMessage> = {}): FormattedMessage {
  return {
    role: 'user',
    uid: 1000 + messageId,
    messageId,
    fullName: `User${messageId}`,
    username: `user${messageId}`,
    textContent: `这是一条足够长的有内容消息${messageId}`,
    timestamp: Math.floor(Date.now() / 1000) - 60,
    isBot: false,
    isForwarded: false,
    ...over,
  } as FormattedMessage;
}

beforeEach(() => {
  zsets.clear();
  redisMock.zmscore.mockClear();
});

describe('answered store / revisit candidates', () => {
  it('unanswered substantive messages become candidates (most recent first capped at 2)', async () => {
    const recent = [msg(1), msg(2), msg(3)];
    const out = await pickRevisitCandidates(CHAT, recent, [], BOT_UID);
    expect(out.map((c) => c.messageId)).toEqual([2, 3]);
    expect(out[0]!.sender).toBe('User2');
  });

  it('answered messages are excluded', async () => {
    await markAnswered(CHAT, [2, 3]);
    const out = await pickRevisitCandidates(CHAT, [msg(1), msg(2), msg(3)], [], BOT_UID);
    expect(out.map((c) => c.messageId)).toEqual([1]);
  });

  it('excludes the current burst, bot/assistant messages, stale and trivial ones', async () => {
    const recent = [
      msg(1),
      msg(2, { role: 'assistant' }),
      msg(3, { isBot: true }),
      msg(4, { uid: BOT_UID }),
      msg(5, { timestamp: Math.floor(Date.now() / 1000) - 3600 }), // stale
      msg(6, { textContent: '哈哈' }), // trivial, no question mark
      msg(7), // in current burst
      msg(8),
    ];
    const out = await pickRevisitCandidates(CHAT, recent, [7], BOT_UID);
    expect(out.map((c) => c.messageId)).toEqual([1, 8]);
  });

  it('short questions still qualify', async () => {
    const out = await pickRevisitCandidates(CHAT, [msg(1, { textContent: '为什么?' })], [], BOT_UID);
    expect(out.map((c) => c.messageId)).toEqual([1]);
  });

  it('returns empty without touching redis when nothing is eligible', async () => {
    const out = await pickRevisitCandidates(CHAT, [msg(1, { textContent: '嗯' })], [], BOT_UID);
    expect(out).toEqual([]);
    expect(redisMock.zmscore).not.toHaveBeenCalled();
  });
});
