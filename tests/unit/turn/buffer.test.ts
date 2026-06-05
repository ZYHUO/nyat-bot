import { describe, it, expect, beforeEach, vi } from 'vitest';

// In-memory Redis mock with list + hash + multi support
const lists = new Map<string, string[]>();
const hashes = new Map<string, Record<string, string>>();

const redisMock = {
  rpush: vi.fn(async (k: string, v: string) => {
    const l = lists.get(k) ?? [];
    l.push(v);
    lists.set(k, l);
    return l.length;
  }),
  lrange: vi.fn(async (k: string, start: number, stop: number) => {
    const l = lists.get(k) ?? [];
    const end = stop === -1 ? l.length : stop + 1;
    return l.slice(start, end);
  }),
  llen: vi.fn(async (k: string) => (lists.get(k) ?? []).length),
  del: vi.fn(async (k: string) => {
    const had = lists.delete(k) || hashes.delete(k);
    return had ? 1 : 0;
  }),
  hset: vi.fn(async (k: string, ...args: string[]) => {
    const h = hashes.get(k) ?? {};
    for (let i = 0; i < args.length; i += 2) h[args[i]!] = args[i + 1]!;
    hashes.set(k, h);
    return 1;
  }),
  hsetnx: vi.fn(async (k: string, f: string, v: string) => {
    const h = hashes.get(k) ?? {};
    if (f in h) return 0;
    h[f] = v;
    hashes.set(k, h);
    return 1;
  }),
  hget: vi.fn(async (k: string, f: string) => hashes.get(k)?.[f] ?? null),
  hgetall: vi.fn(async (k: string) => hashes.get(k) ?? {}),
  hdel: vi.fn(async (k: string, ...fields: string[]) => {
    const h = hashes.get(k);
    if (!h) return 0;
    let n = 0;
    for (const f of fields) {
      if (f in h) {
        delete h[f];
        n++;
      }
    }
    return n;
  }),
  hincrby: vi.fn(async (k: string, f: string, by: number) => {
    const h = hashes.get(k) ?? {};
    const next = Number(h[f] ?? '0') + by;
    h[f] = String(next);
    hashes.set(k, h);
    return next;
  }),
  expire: vi.fn(async () => 1),
  multi: () => {
    const ops: Array<() => Promise<unknown>> = [];
    const m: Record<string, unknown> = {};
    for (const name of ['rpush', 'expire', 'hsetnx', 'hset', 'hdel', 'lrange', 'del'] as const) {
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
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import {
  appendPending,
  drainPending,
  pendingCount,
  getTurnMeta,
  setScheduledJob,
  clearScheduledJob,
  markDirty,
  clearDirty,
  bumpEpoch,
  getHighWatermark,
} from '../../../src/pipeline/turn/buffer.js';

const CHAT = -100500;

function entry(messageId: number, direct = false) {
  return {
    update: { update_id: messageId } as never,
    chatId: CHAT,
    messageId,
    enqueuedAt: Date.now(),
    direct,
  };
}

beforeEach(() => {
  lists.clear();
  hashes.clear();
});

describe('turn pending buffer', () => {
  it('appends entries and drains them in order', async () => {
    await appendPending(entry(1));
    await appendPending(entry(2));
    const { count } = await appendPending(entry(3, true));
    expect(count).toBe(3);

    const drained = await drainPending(CHAT);
    expect(drained.map((d) => d.messageId)).toEqual([1, 2, 3]);
    expect(drained[2]!.direct).toBe(true);

    // Buffer is empty after drain
    expect(await pendingCount(CHAT)).toBe(0);
    expect(await drainPending(CHAT)).toEqual([]);
  });

  it('sets firstPendingAt once and clears it on drain', async () => {
    const first = await appendPending(entry(1));
    await new Promise((r) => setTimeout(r, 5));
    const second = await appendPending(entry(2));
    expect(second.firstPendingAt).toBe(first.firstPendingAt);

    await drainPending(CHAT);
    const meta = await getTurnMeta(CHAT);
    expect(meta.firstPendingAt).toBeUndefined();
  });

  it('tracks the high-watermark as max messageId seen', async () => {
    await appendPending(entry(10));
    await appendPending(entry(8)); // out-of-order edit/late delivery
    await appendPending(entry(15));
    expect(await getHighWatermark(CHAT)).toBe(15);
  });

  it('drops malformed entries on drain instead of throwing', async () => {
    await appendPending(entry(1));
    lists.get(`xxb:turn:pending:${CHAT}`)!.push('{not-json');
    await appendPending(entry(2));

    const drained = await drainPending(CHAT);
    expect(drained.map((d) => d.messageId)).toEqual([1, 2]);
  });

  it('scheduledJobId guard: clear only when matching', async () => {
    await setScheduledJob(CHAT, 'turn-a');
    await clearScheduledJob(CHAT, 'turn-b'); // stale clear → ignored
    expect((await getTurnMeta(CHAT)).scheduledJobId).toBe('turn-a');

    await clearScheduledJob(CHAT, 'turn-a');
    expect((await getTurnMeta(CHAT)).scheduledJobId).toBeUndefined();
  });

  it('dirty flag set/clear reports prior state', async () => {
    expect(await clearDirty(CHAT)).toBe(false);
    await markDirty(CHAT);
    expect((await getTurnMeta(CHAT)).dirty).toBe(true);
    expect(await clearDirty(CHAT)).toBe(true);
    expect(await clearDirty(CHAT)).toBe(false);
  });

  it('bumpEpoch increments monotonically', async () => {
    expect(await bumpEpoch(CHAT)).toBe(1);
    expect(await bumpEpoch(CHAT)).toBe(2);
    expect((await getTurnMeta(CHAT)).epoch).toBe(2);
  });
});
