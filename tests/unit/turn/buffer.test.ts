import { describe, it, expect, beforeEach, vi } from 'vitest';

// In-memory Redis mock with list + hash + set + multi support
const lists = new Map<string, string[]>();
const hashes = new Map<string, Record<string, string>>();
const sets = new Map<string, Set<string>>();

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
  // Emulates the Lua scripts' atomic semantics (the mock has no Lua VM; each
  // script's contract is asserted through its wrapper's behavior). Dispatches
  // on numKeys: 2 = APPEND_PENDING_LUA, 3 = REINJECT_DEFER_LUA.
  eval: vi.fn(async (_script: string, numKeys: number, ...rest: string[]) => {
    if (numKeys === 3) {
      // REINJECT_DEFER_LUA: [pending, meta, dedupSet], [token, ttl, now, itemsJson]
      const [pendingKey, metaKey, dedupKey, token, _ttl, now, itemsJson] = rest;
      const set = sets.get(dedupKey!) ?? new Set<string>();
      if (set.has(token!)) return -1; // 已注入过,原子跳过
      const items = JSON.parse(itemsJson!) as Array<{ json: string; messageId: number; direct: boolean }>;
      const l = lists.get(pendingKey!) ?? [];
      const h = hashes.get(metaKey!) ?? {};
      for (const it of items) {
        l.push(it.json);
        if (it.messageId > 0) {
          const hwm = Number(h['highWatermark'] ?? '0');
          if (it.messageId > hwm) h['highWatermark'] = String(it.messageId);
        }
        if (it.direct) h['pendingDirect'] = '1';
      }
      lists.set(pendingKey!, l);
      if (!('firstPendingAt' in h)) h['firstPendingAt'] = now!;
      h['lastMsgAt'] = now!;
      hashes.set(metaKey!, h);
      set.add(token!);
      sets.set(dedupKey!, set);
      return items.length;
    }
    // APPEND_PENDING_LUA: [pending, meta], [entryJson, now, ttl, direct, msgId]
    const [pendingKey, metaKey, entryJson, now, _ttl, direct, msgId] = rest;
    const l = lists.get(pendingKey!) ?? [];
    l.push(entryJson!);
    lists.set(pendingKey!, l);
    const h = hashes.get(metaKey!) ?? {};
    if (!('firstPendingAt' in h)) h['firstPendingAt'] = now!;
    h['lastMsgAt'] = now!;
    if (direct === '1') h['pendingDirect'] = '1';
    const m = Number(msgId);
    if (m > 0) {
      const hwm = Number(h['highWatermark'] ?? '0');
      if (m > hwm) h['highWatermark'] = msgId!;
    }
    hashes.set(metaKey!, h);
    return [l.length, h['firstPendingAt']];
  }),
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
  hasPendingDirect,
  reinjectDeferEntries,
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
  sets.clear();
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

  it('appendPending is a single round-trip (one eval, no multi/hget/hset)', async () => {
    redisMock.eval.mockClear();
    redisMock.hget.mockClear();
    redisMock.hset.mockClear();
    redisMock.hsetnx.mockClear();
    redisMock.rpush.mockClear();

    await appendPending(entry(1));

    // 旧实现:1 multi + hget + 条件 hset + hget = 最多 4 RTT。
    // 新契约:整个 append 是一次 eval,别的什么都不发。
    expect(redisMock.eval).toHaveBeenCalledTimes(1);
    expect(redisMock.hget).not.toHaveBeenCalled();
    expect(redisMock.hset).not.toHaveBeenCalled();
    expect(redisMock.hsetnx).not.toHaveBeenCalled();
    expect(redisMock.rpush).not.toHaveBeenCalled();
  });

  it('pendingDirect set only when entry.direct, cleared on drain', async () => {
    await appendPending(entry(1, false));
    expect(await hasPendingDirect(CHAT)).toBe(false);

    await appendPending(entry(2, true));
    expect(await hasPendingDirect(CHAT)).toBe(true);

    await drainPending(CHAT);
    expect(await hasPendingDirect(CHAT)).toBe(false);
  });

  it('skips high-watermark write for entries without a messageId', async () => {
    await appendPending(entry(0)); // messageId 0 → 不写 hwm
    expect(await getHighWatermark(CHAT)).toBe(0);
    await appendPending(entry(7));
    expect(await getHighWatermark(CHAT)).toBe(7);
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

describe('reinjectDeferEntries — 幂等重注入(review R3#1)', () => {
  const dEntry = (messageId: number) => ({
    update: { update_id: messageId } as never,
    chatId: CHAT,
    messageId,
    enqueuedAt: 1,
    deferReplay: true,
    deferCount: 1,
  });

  it('首次注入:条目进 pending,meta 更新,返回条目数', async () => {
    const n = await reinjectDeferEntries(CHAT, 'job-1', [dEntry(42)]);
    expect(n).toBe(1);
    const drained = await drainPending(CHAT);
    expect(drained).toHaveLength(1);
    expect(drained[0]!.messageId).toBe(42);
    expect(drained[0]!.deferReplay).toBe(true);
  });

  it('同令牌重试(BullMQ attempts):第二次原子跳过,返回 -1,不重复注入', async () => {
    const first = await reinjectDeferEntries(CHAT, 'job-dup', [dEntry(42)]);
    expect(first).toBe(1);
    // 模拟 scheduleTurn 失败后的 BullMQ 重试:同一 job(同令牌)再来一次
    const second = await reinjectDeferEntries(CHAT, 'job-dup', [dEntry(42)]);
    expect(second).toBe(-1);
    // pending 里只有一份 —— 重复回复被根治
    expect(await pendingCount(CHAT)).toBe(1);
  });

  it('不同令牌:各自独立注入(合法的多次 defer 不被误去重)', async () => {
    await reinjectDeferEntries(CHAT, 'job-a', [dEntry(1)]);
    await reinjectDeferEntries(CHAT, 'job-b', [dEntry(2)]);
    expect(await pendingCount(CHAT)).toBe(2);
  });

  it('空数组 → 0,不碰 pending', async () => {
    expect(await reinjectDeferEntries(CHAT, 'job-empty', [])).toBe(0);
    expect(await pendingCount(CHAT)).toBe(0);
  });

  it('多条目一次注入:全部进 pending + highWatermark 取最大', async () => {
    await reinjectDeferEntries(CHAT, 'job-multi', [dEntry(5), dEntry(9), dEntry(7)]);
    expect(await pendingCount(CHAT)).toBe(3);
    expect(await getHighWatermark(CHAT)).toBe(9);
  });
});
