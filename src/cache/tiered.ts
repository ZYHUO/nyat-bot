import type { LRUCache } from 'lru-cache';
import type { RedisCache } from './redis-cache.js';

/**
 * Two-tier cache: L1 in-process LRU → L2 Redis.
 * Reads check L1 first; on miss, check L2 and backfill L1.
 * Writes go to both layers.
 */
export class TieredCache<V extends NonNullable<unknown>> {
  constructor(
    private readonly l1: LRUCache<string, V>,
    private readonly l2: RedisCache,
    private readonly l1TtlMs = 60_000,
    private readonly l2TtlSeconds = 300,
  ) {}

  async get(key: string): Promise<V | undefined> {
    // L1 hit
    const l1Val = this.l1.get(key);
    if (l1Val !== undefined) return l1Val;

    // L2 hit → backfill L1
    const l2Val = await this.l2.get<V>(key);
    if (l2Val !== undefined) {
      this.l1.set(key, l2Val, { ttl: this.l1TtlMs });
      return l2Val;
    }

    return undefined;
  }

  async set(key: string, value: V): Promise<void> {
    this.l1.set(key, value, { ttl: this.l1TtlMs });
    await this.l2.set(key, value, this.l2TtlSeconds);
  }

  async del(key: string): Promise<void> {
    this.l1.delete(key);
    await this.l2.del(key);
  }
}
