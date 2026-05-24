import { LRUCache } from 'lru-cache';

export interface LruOptions {
  max?: number;
  ttlMs?: number;
}

export function createLru<V extends NonNullable<unknown>>(opts: LruOptions = {}): LRUCache<string, V> {
  return new LRUCache<string, V>({
    max: opts.max ?? 1000,
    ttl: opts.ttlMs ?? 5 * 60 * 1000, // 5 min default
  });
}
