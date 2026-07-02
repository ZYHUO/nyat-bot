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
import { saveObligation, setActiveObligation, supersedeActiveObligation, getObligation, updateObligationState } from '../../../../src/pipeline/turn/obligation-store.js';

describe('obligation lifecycle', () => {
  beforeEach(() => {
    jsonStore.clear();
    hashStore.clear();
    zsets.clear();
  });

  it('marks previous active obligation as superseded', async () => {
    const a = createReplyObligation({ chatId: -100, message: { role: 'user', uid: 1, username: 'a', fullName: 'A', timestamp: 0, messageId: 1, textContent: 'a', isForwarded: false }, kind: 'mention', directInteraction: true, mustReplyStrong: true });
    const b = createReplyObligation({ chatId: -100, message: { role: 'user', uid: 2, username: 'b', fullName: 'B', timestamp: 0, messageId: 2, textContent: 'b', isForwarded: false }, kind: 'mention', directInteraction: true, mustReplyStrong: true });
    await saveObligation(a);
    await saveObligation(b);
    await setActiveObligation(-100, a.id);
    await supersedeActiveObligation(-100, b.id);
    const updated = await getObligation(-100, a.id);
    expect(updated?.state).toBe('superseded');
    expect(updated?.supersededBy).toBe(b.id);
  });

  it('marks obligation dropped with reason', async () => {
    const a = createReplyObligation({ chatId: -100, message: { role: 'user', uid: 1, username: 'a', fullName: 'A', timestamp: 0, messageId: 1, textContent: 'a', isForwarded: false }, kind: 'mention', directInteraction: true, mustReplyStrong: true });
    await saveObligation(a);
    await updateObligationState(-100, a.id, 'dropped', { reason: 'gate_no_action' });
    const updated = await getObligation(-100, a.id);
    expect(updated?.state).toBe('dropped');
    expect(updated?.reason).toBe('gate_no_action');
  });
});
