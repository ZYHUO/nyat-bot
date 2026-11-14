import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { AttentionItem } from '../../../src/meta/types.js';
const f = vi.hoisted(() => ({ exec: vi.fn(), tick: vi.fn() }));
vi.mock('../../../src/env.js', () => ({ env: () => ({ META_DIRECT_COALESCE_MS: 0, META_DIRECT_COALESCE_MAX_MS: 2000 }) }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn() } }));
vi.mock('../../../src/meta/input-scope.js', () => ({ inspectMetaAttention: (value: AttentionItem) => ({ status: 'valid', value }), holdMetaScopeInput: async () => true }));
vi.mock('../../../src/meta/answered.js', () => ({ isMessageAnswered: async () => false }));
vi.mock('../../../src/meta/loop.js', () => ({ metaTick: f.tick }));
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => ({ llen: async () => 0, multi: () => {
  const transaction = { lpush: () => transaction, ltrim: () => transaction, exec: f.exec }; return transaction;
} }) }));
import { _resetAttentionAccumulator, getAttentionAccumulator } from '../../../src/meta/attention.js';
beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); _resetAttentionAccumulator(); });
afterEach(() => { _resetAttentionAccumulator(); vi.useRealTimers(); });
describe('strict Attention durable handoff', () => {
  it.each([null, [[new Error('synthetic Redis transaction failure'), null]]])('rejects transaction failure instead of claiming a local fallback is durable', async result => {
    f.exec.mockResolvedValue(result);
    await expect(getAttentionAccumulator().ingestAsync({ chatId: 9, messageId: 1, layer: 'L0', reason: 'dm' }, { requireDurable: true }))
      .rejects.toThrow('attention_redis_transaction_failed');
    expect(await getAttentionAccumulator().size()).toBe(0);
    await vi.advanceTimersByTimeAsync(1000); expect(f.tick).not.toHaveBeenCalled();
  });
  it('keeps the existing non-strict fallback behavior behind the old caller contract', async () => {
    f.exec.mockRejectedValue(new Error('synthetic Redis offline'));
    await expect(getAttentionAccumulator().ingestAsync({ chatId: -9, messageId: 1, layer: 'L1', reason: 'heart:test' })).resolves.not.toBeNull();
    expect(await getAttentionAccumulator().size()).toBe(1);
  });
});
