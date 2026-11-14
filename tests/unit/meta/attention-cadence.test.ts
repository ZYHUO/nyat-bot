import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MetaRedisFixture } from '../../helpers/meta-redis.js';
import type { AttentionItem } from '../../../src/meta/types.js';

const mocks = vi.hoisted(() => ({ redis: vi.fn(), tick: vi.fn(), batches: [] as AttentionItem[][],
  config: { META_L0_COALESCE_MS: 2800, META_ATTENTION_TOP_N: 20, META_DIRECT_COALESCE_MS: 0, META_DIRECT_COALESCE_MAX_MS: 2000 },
}));
vi.mock('../../../src/db/redis.js', () => ({ getRedis: mocks.redis }));
vi.mock('../../../src/env.js', () => ({ env: () => mocks.config }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() } }));
vi.mock('../../../src/metrics/registry.js', () => ({ incrCounter: vi.fn() }));
vi.mock('../../../src/meta/loop.js', () => ({ metaTick: mocks.tick }));
// Real SQLite recall behavior is covered by onebot-cadence; this suite isolates
// scheduling and Redis marker races without requiring platform identities.
vi.mock('../../../src/platform/onebot-notices.js', () => ({ isOneBotMessageRecalled: () => false }));

import { getAttentionAccumulator, _resetAttentionAccumulator } from '../../../src/meta/attention.js';
import { batchMessagesAnswered, isMessageAnswered, markMessageAnswered } from '../../../src/meta/answered.js';

const QQ_GROUP = -(2 ** 52 + 10);
const QQ_DM = 2 ** 52 + 11;
let redis: MetaRedisFixture;
const add = (chatId: number, messageId: number, layer: AttentionItem['layer'] = 'L0') =>
  getAttentionAccumulator().ingestAsync({ chatId, messageId, layer, reason: layer === 'L0' ? 'dm' : 'heart:reply' });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-14T12:00:00Z'));
  _resetAttentionAccumulator();
  mocks.config.META_DIRECT_COALESCE_MS = 0; mocks.config.META_DIRECT_COALESCE_MAX_MS = 2000;
  mocks.batches.length = 0;
  mocks.tick.mockReset();
  mocks.tick.mockImplementation(async () => { mocks.batches.push(await getAttentionAccumulator().flush()); });
  redis = new MetaRedisFixture(); mocks.redis.mockReturnValue(redis);
});
afterEach(() => { _resetAttentionAccumulator(); vi.useRealTimers(); });

describe('shared QQ/Telegram Attention cadence', () => {
  it('passive coalescing cannot postpone a pending direct wake from another chat', async () => {
    await add(QQ_DM, 11);
    await add(-123, 12, 'L1');
    // A periodic flush claims the direct item but schedules the passive quiet
    // window. The already scheduled immediate wake must retain its deadline.
    expect((await getAttentionAccumulator().flush()).map(item => item.messageId)).toEqual([11]);
    await vi.advanceTimersByTimeAsync(10);
    await add(QQ_DM, 13);
    await vi.advanceTimersByTimeAsync(40);
    expect(mocks.batches.flat().map(item => item.messageId)).toEqual([13]);
    expect(await getAttentionAccumulator().peek()).toEqual([expect.objectContaining({ messageId: 12 })]);
    await vi.advanceTimersByTimeAsync(2780);
    expect(mocks.batches.flat().map(item => item.messageId)).toEqual([13, 12]);
  });

  it('continuous direct traffic cannot push the first scheduled wake indefinitely', async () => {
    await add(QQ_DM, 21);
    await vi.advanceTimersByTimeAsync(20); await add(123, 22);
    await vi.advanceTimersByTimeAsync(20); await add(QQ_DM, 23);
    await vi.advanceTimersByTimeAsync(10);
    expect(mocks.tick).toHaveBeenCalledOnce();
    expect(mocks.batches[0]?.map(item => item.messageId)).toEqual([21, 22, 23]);
    expect(await getAttentionAccumulator().size()).toBe(0);
  });

  it.each([QQ_GROUP, -123])('holds a passive burst until that chat is quiet (%s)', async chatId => {
    await add(chatId, 31, 'L1');
    expect(await getAttentionAccumulator().flush()).toEqual([]);
    await vi.advanceTimersByTimeAsync(2000); await add(chatId, 32, 'L1');
    await vi.advanceTimersByTimeAsync(830);
    expect(mocks.batches.flat()).toEqual([]);
    expect(await getAttentionAccumulator().size()).toBe(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(mocks.batches.flat().map(item => item.messageId)).toEqual([31, 32]);
    expect(await getAttentionAccumulator().size()).toBe(0);
  });

  it('reset cancels an outstanding wake rather than waking a new accumulator', async () => {
    await add(QQ_DM, 41);
    _resetAttentionAccumulator();
    await vi.advanceTimersByTimeAsync(100);
    expect(mocks.tick).not.toHaveBeenCalled();
  });
});

describe('optional direct-message burst window', () => {
  beforeEach(() => { mocks.config.META_DIRECT_COALESCE_MS = 800; });

  it('waits for the last bubble, independently for QQ and Telegram chats', async () => {
    await add(QQ_DM, 101);
    await vi.advanceTimersByTimeAsync(300); await add(QQ_DM, 102);
    await vi.advanceTimersByTimeAsync(300); await add(123, 103);
    await vi.advanceTimersByTimeAsync(400); await add(QQ_DM, 104);
    expect(mocks.batches.flat()).toEqual([]);
    await vi.advanceTimersByTimeAsync(400);
    expect(mocks.batches.flat().map(item => item.messageId)).toEqual([103]);
    await vi.advanceTimersByTimeAsync(400);
    expect(mocks.batches.filter(batch => batch.length).map(batch => batch.map(item => item.messageId)))
      .toEqual([[103], [101, 102, 104]]);
  });

  it('caps a continuous direct burst at two seconds from its first item', async () => {
    await add(QQ_DM, 201);
    for (let i = 1; i <= 6; i++) {
      await vi.advanceTimersByTimeAsync(300); await add(QQ_DM, 201 + i);
    }
    expect(mocks.batches.flat()).toEqual([]);
    await vi.advanceTimersByTimeAsync(200);
    expect(mocks.batches.flat().map(item => item.messageId)).toEqual([201, 202, 203, 204, 205, 206, 207]);
    expect(await getAttentionAccumulator().size()).toBe(0);
  });

  it('does not reset the oldest timestamp on busy requeue or mark a newer message answered', async () => {
    await add(QQ_DM, 301);
    await vi.advanceTimersByTimeAsync(800);
    const inFlight = mocks.batches.flat();
    expect(inFlight.map(item => item.messageId)).toEqual([301]);
    await vi.advanceTimersByTimeAsync(2000);
    await getAttentionAccumulator().requeue(inFlight);
    await add(QQ_DM, 302);
    // The old busy item has passed its maximum wait; no fresh 800 ms wait.
    const batch = await getAttentionAccumulator().flush();
    expect(batch.map(item => item.messageId)).toEqual([301, 302]);
    await getAttentionAccumulator().requeue(batch);
    await markMessageAnswered(QQ_DM, 301);
    expect(await isMessageAnswered(QQ_DM, 302)).toBe(false);
    expect(await getAttentionAccumulator().flush()).toEqual([]); // only the new item waits now
    await vi.advanceTimersByTimeAsync(800);
    expect(mocks.batches.flat().map(item => item.messageId)).toEqual([301, 302]);
  });

  it('brings passive context into a direct group batch but leaves callbacks immediate', async () => {
    await add(QQ_GROUP, 401, 'L1');
    await add(QQ_GROUP, 402, 'L0');
    await getAttentionAccumulator().ingestAsync({ chatId: QQ_GROUP, layer: 'L1_CALLBACK', reason: 'callback:ok' });
    expect((await getAttentionAccumulator().flush()).map(item => item.layer)).toEqual(['L1_CALLBACK']);
    await vi.advanceTimersByTimeAsync(800);
    expect(mocks.batches.flat().map(item => item.messageId)).toEqual([402, 401]);
  });

  it('honors a maximum smaller than the configured quiet window', async () => {
    mocks.config.META_DIRECT_COALESCE_MAX_MS = 500;
    await add(QQ_DM, 501); await vi.advanceTimersByTimeAsync(500);
    expect(mocks.batches.flat().map(item => item.messageId)).toEqual([501]);
  });
});

describe('answered markers stay consistent after a queued message is sent', () => {
  it.each([QQ_GROUP, -123])('flush and requeue exclude current timestamp marks (%s)', async chatId => {
    await add(chatId, 51);
    await add(chatId, 52);
    // The send completed after ingress, so only flush's batch read can reject it.
    await markMessageAnswered(chatId, 51);
    expect(await isMessageAnswered(chatId, 51)).toBe(true);
    const remaining = await getAttentionAccumulator().flush();
    expect(remaining.map(item => item.messageId)).toEqual([52]);
    await getAttentionAccumulator().requeue(remaining);
    await markMessageAnswered(chatId, 52);
    expect(await getAttentionAccumulator().flush()).toEqual([]);
  });

  it('batch reads accept legacy and timestamp formats, without leaking marks across chats', async () => {
    const raw = ['1', '1794657600', '1794657500,1794657600', '', '0'];
    for (const [index, value] of raw.entries()) await redis.set(`xxb:meta:answered:${QQ_GROUP}:${index + 1}`, value);
    const entries = [...raw.map((_, index) => ({ chatId: QQ_GROUP, messageId: index + 1 })), { chatId: -123, messageId: 1 }];
    expect(await batchMessagesAnswered(entries)).toEqual(new Set([1, 2, 3].map(id => `${QQ_GROUP}:${id}`)));
    expect(await Promise.all(entries.map(entry => isMessageAnswered(entry.chatId, entry.messageId))))
      .toEqual([true, true, true, false, false, false]);
  });
});
