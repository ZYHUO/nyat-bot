import { describe, it, expect, beforeEach, vi } from 'vitest';

const lists = new Map<string, string[]>();
const hashes = new Map<string, Record<string, string>>();
const jsonStore = new Map<string, string>();
const zsets = new Map<string, string[]>();

const redisMock = {
  hgetall: vi.fn(async (k: string) => hashes.get(k) ?? {}),
  hget: vi.fn(async (k: string, f: string) => hashes.get(k)?.[f] ?? null),
  hset: vi.fn(async (k: string, ...args: string[]) => {
    const h = hashes.get(k) ?? {};
    for (let i = 0; i < args.length; i += 2) h[args[i]!] = args[i + 1]!;
    hashes.set(k, h);
    return 'OK';
  }),
  hdel: vi.fn(async (k: string, ...fields: string[]) => {
    const h = hashes.get(k) ?? {};
    let n = 0;
    for (const f of fields) if (delete h[f]) n++;
    hashes.set(k, h);
    return n;
  }),
  expire: vi.fn(async () => 1),
  set: vi.fn(async (k: string, v: string) => { jsonStore.set(k, v); return 'OK'; }),
  get: vi.fn(async (k: string) => jsonStore.get(k) ?? null),
  zadd: vi.fn(async (k: string, _score: number, member: string) => {
    const arr = zsets.get(k) ?? [];
    if (!arr.includes(member)) arr.push(member);
    zsets.set(k, arr);
    return 1;
  }),
  zrange: vi.fn(async (k: string) => zsets.get(k) ?? []),
  eval: vi.fn(async (_lua: string, _keys: number, pendingKey: string, metaKey: string, entryJson: string, now: string, _ttl: string, direct: string, msgId: string, obligationId: string, obligationStrong: string) => {
    const l = lists.get(pendingKey) ?? [];
    l.push(entryJson);
    lists.set(pendingKey, l);
    const h = hashes.get(metaKey) ?? {};
    h['firstPendingAt'] ??= now;
    h['lastMsgAt'] = now;
    if (direct === '1') h['pendingDirect'] = '1';
    if (obligationId && obligationStrong === '1') h['activeObligationId'] = obligationId;
    const m = Number(msgId);
    const hwm = Number(h['highWatermark'] ?? '0');
    if (m > hwm) h['highWatermark'] = msgId;
    hashes.set(metaKey, h);
    return [l.length, h['firstPendingAt']];
  }),
};

vi.mock('../../../../src/db/redis.js', () => ({ getRedis: () => redisMock }));
vi.mock('../../../../src/shared/logger.js', () => ({ logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() } }));

import { createReplyObligation } from '../../../../src/pipeline/turn/obligation.ts';
import { saveObligation, setActiveObligation, supersedeActiveObligation, getActiveObligationId } from '../../../../src/pipeline/turn/obligation-store.js';
import { appendPending, getTurnMeta } from '../../../../src/pipeline/turn/buffer.js';
import { selectActiveObligation } from '../../../../src/pipeline/turn/obligation-select.ts';

describe('near-e2e cross-user strong vs ambient flow', () => {
  beforeEach(() => {
    lists.clear();
    hashes.clear();
    jsonStore.clear();
    zsets.clear();
  });

  it('keeps active strong obligation in store when later ambient pending arrives', async () => {
    const strong = createReplyObligation({
      chatId: -100,
      message: { role: 'user', uid: 1, username: 'a', fullName: 'A', timestamp: 0, messageId: 10, textContent: '@xxb_bot 这个怎么修', isForwarded: false },
      kind: 'mention',
      directInteraction: true,
      mustReplyStrong: true,
    });
    const ambient = createReplyObligation({
      chatId: -100,
      message: { role: 'user', uid: 2, username: 'b', fullName: 'B', timestamp: 0, messageId: 11, textContent: '今天天气不错', isForwarded: false },
      kind: 'judge_reply',
      directInteraction: false,
      mustReplyStrong: false,
    });
    ambient.priority = 50;

    await saveObligation(strong);
    await setActiveObligation(-100, strong.id);
    await appendPending({ update: {}, chatId: -100, messageId: 10, enqueuedAt: 1, direct: true, obligationId: strong.id, obligationTargetUid: 1, obligationStrong: true });

    await saveObligation(ambient);
    await appendPending({ update: {}, chatId: -100, messageId: 11, enqueuedAt: 2, direct: false, obligationId: ambient.id, obligationTargetUid: 2, obligationStrong: false });

    const meta = await getTurnMeta(-100);
    expect(meta.activeObligationId).toBeUndefined();

    const selected = selectActiveObligation([strong, ambient]).active;
    expect(selected?.id).toBe(strong.id);
    expect(await getActiveObligationId(-100)).toBe(strong.id);
  });

  it('supersedes old strong obligation when newer strong one arrives', async () => {
    const first = createReplyObligation({
      chatId: -100,
      message: { role: 'user', uid: 1, username: 'a', fullName: 'A', timestamp: 0, messageId: 10, textContent: '@xxb_bot 帮我看看', isForwarded: false },
      kind: 'mention',
      directInteraction: true,
      mustReplyStrong: true,
    });
    const second = createReplyObligation({
      chatId: -100,
      message: { role: 'user', uid: 2, username: 'b', fullName: 'B', timestamp: 0, messageId: 11, textContent: '@xxb_bot 先回答我', isForwarded: false },
      kind: 'mention',
      directInteraction: true,
      mustReplyStrong: true,
    });
    await saveObligation(first);
    await setActiveObligation(-100, first.id);
    await saveObligation(second);
    await supersedeActiveObligation(-100, second.id);
    await setActiveObligation(-100, second.id);
    expect(await getActiveObligationId(-100)).toBe(second.id);
  });
});
