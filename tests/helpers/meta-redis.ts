/** Stateful Redis subset for ingress/Attention tests; no network or durable writes. */
export class MetaRedisFixture {
  readonly values = new Map<string, { value: string; expires: number }>();
  readonly lists = new Map<string, string[]>();
  readonly hashes = new Map<string, Map<string, string>>();

  async get(key: string): Promise<string | null> {
    const entry = this.values.get(key);
    if (!entry || entry.expires <= Date.now()) {
      this.values.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, ...args: Array<string | number>): Promise<'OK' | null> {
    // No await between the NX check and write: model Redis's atomic command.
    const previous = this.values.get(key);
    if (args.includes('NX') && previous && previous.expires > Date.now()) return null;
    const ex = args.indexOf('EX');
    const px = args.indexOf('PX');
    this.values.set(key, { value, expires: px >= 0 ? Date.now() + Number(args[px + 1])
      : ex < 0 ? Infinity : Date.now() + Number(args[ex + 1]) * 1000 });
    return 'OK';
  }

  async mget(...keys: string[]): Promise<Array<string | null>> { return Promise.all(keys.map(key => this.get(key))); }
  async getdel(key: string): Promise<string | null> {
    const entry = this.values.get(key);
    this.values.delete(key);
    return entry && entry.expires > Date.now() ? entry.value : null;
  }
  async del(key: string): Promise<number> { return Number(this.values.delete(key) || this.lists.delete(key)); }
  async hsetnx(key: string, field: string, value: string): Promise<number> {
    const hash = this.hashes.get(key) ?? new Map<string, string>();
    if (hash.has(field)) return 0;
    hash.set(field, value); this.hashes.set(key, hash); return 1;
  }
  async llen(key: string): Promise<number> { return this.lists.get(key)?.length ?? 0; }
  async lrange(key: string, start: number, end: number): Promise<string[]> {
    return (this.lists.get(key) ?? []).slice(start, end < 0 ? undefined : end + 1);
  }
  async eval(script: string, _keyCount: number, key: string): Promise<number | string[]> {
    if (script.includes("redis.call('INCR'")) {
      const previous = this.values.get(key);
      const next = Number(previous && previous.expires > Date.now() ? previous.value : 0) + 1;
      this.values.set(key, { value: String(next), expires: Date.now() + 60_000 });
      return next;
    }
    if (script.includes("redis.call('LRANGE'") && script.includes("redis.call('DEL'")) {
      const result = [...(this.lists.get(key) ?? [])];
      this.lists.delete(key);
      return result;
    }
    throw new Error('Unsupported Redis Lua in Meta fixture');
  }
  multi() {
    const operations: Array<() => void> = [];
    const pipeline = {
      lpush: (key: string, value: string) => {
        operations.push(() => this.lists.set(key, [value, ...(this.lists.get(key) ?? [])])); return pipeline;
      },
      rpush: (key: string, value: string) => {
        operations.push(() => this.lists.set(key, [...(this.lists.get(key) ?? []), value])); return pipeline;
      },
      ltrim: (key: string, start: number, end: number) => {
        operations.push(() => this.lists.set(key, (this.lists.get(key) ?? []).slice(start, end + 1))); return pipeline;
      },
      exec: async () => { operations.forEach(operation => operation()); return operations.map(() => [null, 1]); },
    };
    return pipeline;
  }
}
