import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LRUCache } from 'lru-cache';
import { TieredCache } from '../../../src/cache/tiered.js';
import type { RedisCache } from '../../../src/cache/redis-cache.js';

function makeMockRedis(): RedisCache {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async <T>(key: string): Promise<T | undefined> => {
      const raw = store.get(key);
      return raw !== undefined ? (JSON.parse(raw) as T) : undefined;
    }),
    set: vi.fn(async <T>(key: string, value: T, _ttl?: number): Promise<void> => {
      store.set(key, JSON.stringify(value));
    }),
    del: vi.fn(async (key: string): Promise<void> => {
      store.delete(key);
    }),
    has: vi.fn(async (key: string): Promise<boolean> => store.has(key)),
    _store: store,
  } as unknown as RedisCache & { _store: Map<string, string> };
}

describe('TieredCache', () => {
  let l1: LRUCache<string, string>;
  let l2: RedisCache & { _store: Map<string, string> };
  let cache: TieredCache<string>;

  beforeEach(() => {
    l1 = new LRUCache<string, string>({ max: 100, ttl: 60_000 });
    l2 = makeMockRedis() as ReturnType<typeof makeMockRedis> & { _store: Map<string, string> };
    cache = new TieredCache(l1, l2, 60_000, 300);
  });

  it('returns undefined on total miss', async () => {
    expect(await cache.get('nope')).toBeUndefined();
  });

  it('set() writes to both L1 and L2', async () => {
    await cache.set('k1', 'hello');
    expect(l1.get('k1')).toBe('hello');
    expect(l2.set).toHaveBeenCalledWith('k1', 'hello', 300);
  });

  it('get() hits L1 first without touching L2', async () => {
    l1.set('k2', 'from-l1');
    const val = await cache.get('k2');
    expect(val).toBe('from-l1');
    expect(l2.get).not.toHaveBeenCalled();
  });

  it('get() falls through to L2 on L1 miss, then backfills L1', async () => {
    l2._store.set('k3', JSON.stringify('from-l2'));
    const val = await cache.get('k3');
    expect(val).toBe('from-l2');
    expect(l1.get('k3')).toBe('from-l2');
  });

  it('del() removes from both layers', async () => {
    await cache.set('k4', 'bye');
    await cache.del('k4');
    expect(l1.get('k4')).toBeUndefined();
    expect(l2.del).toHaveBeenCalledWith('k4');
  });
});
