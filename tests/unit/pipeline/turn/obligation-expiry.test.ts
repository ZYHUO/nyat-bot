import { describe, it, expect, beforeEach, vi } from 'vitest';

const jsonStore = new Map<string, string>();
const hashStore = new Map<string, Record<string, string>>();
const zsets = new Map<string, string[]>();

const redisMock = {
  set: vi.fn(async (k: string, v: string) => { jsonStore.set(k, v); return 'OK'; }),
  get: vi.fn(async (k: string) => jsonStore.get(k) ?? null),
  zadd: vi.fn(async (k: string, _score: number, member: string) => {
    const arr = zsets.get(k) ?? [];
    if (!arr.includes(member)) arr.push(member);
    zsets.set(k, arr);
    return 1;
  }),
  zrange: vi.fn(async (k: string) => zsets.get(k) ?? []),
  expire: vi.fn(async () => 1),
  hset: vi.fn(async (k: string, ...args: string[]) => {
    const h = hashStore.get(k) ?? {};
    for (let i = 0; i < args.length; i += 2) h[args[i]!] = args[i + 1]!;
    hashStore.set(k, h);
    return 'OK';
  }),
  hget: vi.fn(async (k: string, field: string) => hashStore.get(k)?.[field] ?? null),
  hdel: vi.fn(async (k: string, ...fields: string[]) => {
    const h = hashStore.get(k) ?? {};
    let n = 0;
    for (const f of fields) if (delete h[f]) n++;
    hashStore.set(k, h);
    return n;
  }),
};

vi.mock('../../../../src/db/redis.js', () => ({ getRedis: () => redisMock }));
vi.mock('../../../../src/shared/logger.js', () => ({ logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() } }));

import { createReplyObligation } from '../../../../src/pipeline/turn/obligation.js';
import { saveObligation, expireStaleObligations, getObligation } from '../../../../src/pipeline/turn/obligation-store.js';

describe('obligation expiry', () => {
  beforeEach(() => {
    jsonStore.clear();
    hashStore.clear();
    zsets.clear();
  });

  it('drops stale obligation after max age', async () => {
    const a = createReplyObligation({ chatId: -100, message: { role: 'user', uid: 1, username: 'a', fullName: 'A', timestamp: 0, messageId: 1, textContent: 'a', isForwarded: false }, kind: 'mention', directInteraction: true, mustReplyStrong: true });
    a.createdAt = 1;
    a.updatedAt = 1;
    await saveObligation(a);
    const expired = await expireStaleObligations(-100, 1000, 10);
    expect(expired).toBe(1);
    const updated = await getObligation(-100, a.id);
    expect(updated?.state).toBe('dropped');
    expect(updated?.reason).toContain('stale_expired');
  });
});
