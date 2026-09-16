import type Redis from 'ioredis';

export class RedisCache {
  constructor(
    private readonly redis: Redis,
    private readonly prefix = 'xxb:cache:',
  ) {}

  async get<T>(key: string): Promise<T | undefined> {
    const raw = await this.redis.get(this.prefix + key);
    if (raw === null) return undefined;
    return JSON.parse(raw) as T;
  }

  async set<T>(key: string, value: T, ttlSeconds = 300): Promise<void> {
    await this.redis.set(this.prefix + key, JSON.stringify(value), 'EX', ttlSeconds);
  }

  async del(key: string): Promise<void> {
    await this.redis.del(this.prefix + key);
  }

  async has(key: string): Promise<boolean> {
    return (await this.redis.exists(this.prefix + key)) === 1;
  }
}
