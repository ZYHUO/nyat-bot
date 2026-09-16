import { describe, it, expect, beforeEach, vi } from 'vitest';

const store = new Map<string, Record<string, string>>();
const listStore = new Map<string, string[]>();

const redisMock = {
  eval: vi.fn(async (_lua: string, _keys: number, pendingKey: string, metaKey: string, entryJson: string, now: string, _ttl: string, direct: string, messageId: string, obligationId: string, obligationStrong: string) => {
    const items = listStore.get(pendingKey) ?? [];
    items.push(entryJson);
    listStore.set(pendingKey, items);
    const meta = store.get(metaKey) ?? {};
    meta['firstPendingAt'] ??= now;
    meta['lastMsgAt'] = now;
    if (direct === '1') meta['pendingDirect'] = '1';
    if (obligationId && obligationStrong === '1') meta['activeObligationId'] = obligationId;
    const mid = Number(messageId || '0');
    const hwm = Number(meta['highWatermark'] || '0');
    if (mid > hwm) meta['highWatermark'] = String(mid);
    store.set(metaKey, meta);
    return [items.length, meta['firstPendingAt']];
  }),
  hgetall: vi.fn(async (k: string) => store.get(k) ?? {}),
};

vi.mock('../../../../src/db/redis.js', () => ({ getRedis: () => redisMock }));
vi.mock('../../../../src/shared/logger.js', () => ({ logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() } }));

import { appendPending, getTurnMeta } from '../../../../src/pipeline/turn/buffer.js';

describe('turn buffer obligation metadata', () => {
  beforeEach(() => {
    store.clear();
    listStore.clear();
  });

  it('keeps obligation metadata out of turn meta on append', async () => {
    await appendPending({
      update: {},
      chatId: -100,
      messageId: 42,
      enqueuedAt: Date.now(),
      direct: true,
      obligationId: 'obl-1',
      obligationTargetUid: 7,
      obligationStrong: true,
    });
    const meta = await getTurnMeta(-100);
    expect(meta.activeObligationId).toBeUndefined();
  });

  it('does not synthesize active obligation state in turn meta', async () => {
    await appendPending({
      update: {},
      chatId: -100,
      messageId: 42,
      enqueuedAt: Date.now(),
      direct: true,
      obligationId: 'strong-1',
      obligationTargetUid: 7,
      obligationStrong: true,
    });
    await appendPending({
      update: {},
      chatId: -100,
      messageId: 43,
      enqueuedAt: Date.now(),
      direct: false,
      obligationId: 'weak-2',
      obligationTargetUid: 8,
      obligationStrong: false,
    });
    const meta = await getTurnMeta(-100);
    expect(meta.activeObligationId).toBeUndefined();
  });
});
