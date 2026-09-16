import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NyatDb } from '../../../../packages/nyatdb/src/engine.js';
import { unpackChatLogRow } from '../../../../packages/nyatdb/src/chat-log.js';

const lists = new Map<string, string[]>();
const hashes = new Map<string, Map<string, string>>();
const sets = new Map<string, Set<string>>();
const zsets = new Map<string, Map<string, number>>();

const redisMock = {
  eval: vi.fn(async (_script: string, _n: number, key: string, payload: string) => {
    const l = lists.get(key) ?? [];
    l.push(payload);
    lists.set(key, l);
    return l.length;
  }),
  lrange: vi.fn(async (key: string, start: number, end: number) => {
    const l = lists.get(key) ?? [];
    const a = start < 0 ? Math.max(0, l.length + start) : start;
    const b = end < 0 ? l.length + end : end;
    return l.slice(a, b + 1);
  }),
  lindex: vi.fn(async (key: string, idx: number) => {
    const l = lists.get(key) ?? [];
    const i = idx < 0 ? l.length + idx : idx;
    return l[i] ?? null;
  }),
  zadd: vi.fn(async (key: string, score: number, member: string) => {
    const z = zsets.get(key) ?? new Map();
    z.set(member, score);
    zsets.set(key, z);
    return 1;
  }),
  hset: vi.fn(async (key: string, field: string, value: string) => {
    const h = hashes.get(key) ?? new Map();
    h.set(field, value);
    hashes.set(key, h);
    return 1;
  }),
  expire: vi.fn(async () => 1),
  sadd: vi.fn(async (key: string, member: string) => {
    const s = sets.get(key) ?? new Set();
    s.add(member);
    sets.set(key, s);
    return 1;
  }),
  hgetall: vi.fn(async () => ({})),
  smembers: vi.fn(async () => []),
};

const envValues: Record<string, unknown> = {
  NYATDB_ENABLED: true,
  NYATDB_DUAL_WRITE: true,
  NYATDB_READ: true,
  NYATDB_REDIS_MIRROR: false,
  NYATDB_MAX_MESSAGES_PER_CHAT: 5000,
  CONTEXT_MAX_LENGTH: 400,
};

let db: NyatDb | null = null;
let dir = '';

vi.mock('../../../../src/db/redis.js', () => ({ getRedis: () => redisMock }));
vi.mock('../../../../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../../src/env.js', () => ({ env: () => envValues }));
vi.mock('../../../../src/nyatdb/index.js', async () => {
  const real = await vi.importActual<typeof import('../../../../src/nyatdb/index.js')>(
    '../../../../src/nyatdb/index.js',
  );
  return {
    ...real,
    getNyatDb: () => db,
    unpackChatLogRow: real.unpackChatLogRow ?? unpackChatLogRow,
  };
});

import { addMessage, getRecent, _resetNyatCatchUpStateForTests } from '../../../../src/pipeline/context/manager.js';

const CHAT = -424242;

function msg(id: number, text: string, role: 'user' | 'assistant' = 'user') {
  return {
    role,
    uid: role === 'assistant' ? 0 : 7,
    username: 'u',
    fullName: 'User',
    timestamp: 1_780_000_000 + id,
    messageId: id,
    textContent: text,
    isForwarded: false,
  };
}

describe('context manager NyatDB-primary', () => {
  beforeEach(() => {
    lists.clear();
    hashes.clear();
    sets.clear();
    zsets.clear();
    vi.clearAllMocks();
    _resetNyatCatchUpStateForTests();
    envValues.NYATDB_ENABLED = true;
    envValues.NYATDB_DUAL_WRITE = true;
    envValues.NYATDB_READ = true;
    envValues.NYATDB_REDIS_MIRROR = false;
    dir = mkdtempSync(join(tmpdir(), 'ctx-nyat-'));
    db = NyatDb.open({ path: dir, syncEvery: 1, chatRingMax: 100 });
  });

  afterEach(() => {
    db?.close();
    db = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('writes NyatDB and skips Redis ctx when mirror off', async () => {
    await addMessage(CHAT, msg(1, '小鱼干'));
    await addMessage(CHAT, msg(2, '收到', 'assistant'));

    expect(redisMock.eval).not.toHaveBeenCalled();
    const recent = await getRecent(CHAT, 10);
    expect(recent.map((m) => m.textContent)).toEqual(['小鱼干', '收到']);
    expect(recent[1]!.role).toBe('assistant');
  });

  it('skips Redis LRANGE on getRecent after a clean merge', async () => {
    await addMessage(CHAT, msg(1, 'a'));
    await addMessage(CHAT, msg(2, 'b'));
    redisMock.lrange.mockClear();
    redisMock.lindex.mockClear();
    await getRecent(CHAT, 10); // first: peek Redis, settle skip
    const peeks = redisMock.lrange.mock.calls.length;
    expect(peeks).toBeGreaterThan(0);
    redisMock.lrange.mockClear();
    const again = await getRecent(CHAT, 10);
    expect(again.map((m) => m.textContent)).toEqual(['a', 'b']);
    expect(redisMock.lrange).not.toHaveBeenCalled();
  });

  it('mirrors to Redis when NYATDB_REDIS_MIRROR=true', async () => {
    envValues.NYATDB_REDIS_MIRROR = true;
    await addMessage(CHAT, msg(3, '镜像'));
    expect(redisMock.eval).toHaveBeenCalledOnce();
    const key = `xxb:ctx:${CHAT}`;
    expect(lists.get(key)?.length).toBe(1);
  });

  it('falls back to Redis and backfills empty NyatDB', async () => {
    const key = `xxb:ctx:${CHAT}`;
    lists.set(key, [JSON.stringify(msg(10, '来自redis'))]);

    const recent = await getRecent(CHAT, 10);
    expect(recent.map((m) => m.textContent)).toEqual(['来自redis']);

    // After backfill, NyatDB serves the row; Redis is still peeked for hole-merge.
    lists.set(key, []);
    const again = await getRecent(CHAT, 10);
    expect(again.map((m) => m.textContent)).toEqual(['来自redis']);
  });

  it('catches up NyatDB when Redis tip is ahead', async () => {
    // Seed NyatDB tip=1 without marking catchUpSettled via addMessage
    db!.chatAppend(CHAT, {
      messageId: 1,
      ts: 1_780_000_001,
      uid: 7,
      role: 'user',
      text: JSON.stringify({
        role: 'user',
        uid: 7,
        username: 'u',
        fullName: 'User',
        timestamp: 1_780_000_001,
        messageId: 1,
        textContent: 'old',
        isForwarded: false,
      }),
      bodyFormat: 'json',
    });
    const key = `xxb:ctx:${CHAT}`;
    lists.set(key, [
      JSON.stringify(msg(1, 'old')),
      JSON.stringify(msg(2, 'gap-a')),
      JSON.stringify(msg(3, 'gap-b')),
    ]);
    redisMock.lindex = vi.fn(async (k: string, idx: number) => {
      const l = lists.get(k) ?? [];
      const i = idx < 0 ? l.length + idx : idx;
      return l[i] ?? null;
    });

    const recent = await getRecent(CHAT, 10);
    expect(recent.map((m) => m.textContent)).toEqual(['old', 'gap-a', 'gap-b']);
    expect(recent.at(-1)!.messageId).toBe(3);
  });

  it('merges Redis hole messages into NyatDB recent', async () => {
    db!.chatAppend(CHAT, {
      messageId: 10,
      ts: 1_780_000_010,
      uid: 7,
      role: 'user',
      text: JSON.stringify({ ...msg(10, 'early'), role: 'user' }),
      bodyFormat: 'json',
    });
    db!.chatAppend(CHAT, {
      messageId: 30,
      ts: 1_780_000_030,
      uid: 7,
      role: 'user',
      text: JSON.stringify({ ...msg(30, 'late'), role: 'user' }),
      bodyFormat: 'json',
    });
    // Redis has the missing middle (incl. prior bot line) — dual-write hole
    lists.set(`xxb:ctx:${CHAT}`, [
      JSON.stringify(msg(10, 'early')),
      JSON.stringify(msg(20, '哼，谁信你呀', 'assistant')),
      JSON.stringify(msg(30, 'late')),
    ]);

    const recent = await getRecent(CHAT, 10);
    expect(recent.map((m) => m.messageId)).toEqual([10, 20, 30]);
    expect(recent[1]!.textContent).toContain('谁信你');
  });

  it('falls back to Redis write when NyatDB unavailable', async () => {
    db = null;
    await addMessage(CHAT, msg(20, 'redis兜底'));
    expect(redisMock.eval).toHaveBeenCalledOnce();
  });
});
