import { describe, it, expect, beforeEach, vi } from 'vitest';

const redisLists = new Map<string, string[]>();
vi.mock('../../../src/db/redis.js', () => ({
  getRedis: () => ({
    multi: () => {
      const ops: Array<() => void> = [];
      const api = {
        lpush(key: string, val: string) {
          ops.push(() => {
            const arr = redisLists.get(key) ?? [];
            arr.unshift(val);
            redisLists.set(key, arr);
          });
          return api;
        },
        rpush(key: string, val: string) {
          ops.push(() => {
            const arr = redisLists.get(key) ?? [];
            arr.push(val);
            redisLists.set(key, arr);
          });
          return api;
        },
        ltrim(key: string, start: number, stop: number) {
          ops.push(() => {
            const arr = redisLists.get(key) ?? [];
            redisLists.set(key, arr.slice(start, stop + 1));
          });
          return api;
        },
        del(key: string) {
          ops.push(() => {
            redisLists.delete(key);
          });
          return api;
        },
        async exec() {
          for (const op of ops) op();
          return [];
        },
      };
      return api;
    },
    async lrange(key: string, start: number, stop: number) {
      const arr = redisLists.get(key) ?? [];
      if (stop < 0) return arr.slice(start);
      return arr.slice(start, stop + 1);
    },
    async llen(key: string) {
      return (redisLists.get(key) ?? []).length;
    },
    async del(key: string) {
      redisLists.delete(key);
      return 1;
    },
  }),
}));

import {
  ContextEngine,
  _resetContextEngines,
  staticText,
  deltaText,
  ephemeralText,
} from '../../../src/context-engine/index.js';
import {
  AttentionAccumulator,
  _resetAttentionAccumulator,
  MetaSandbox,
  getGlobalState,
  _resetGlobalState,
} from '../../../src/meta/index.js';

describe('ContextEngine', () => {
  beforeEach(() => _resetContextEngines());

  it('orders tiers and reports cache hits on second assemble', async () => {
    const eng = new ContextEngine('test');
    const providers = [
      ephemeralText('e', 'ephemeral-1'),
      staticText('s', 'static-hello'),
      deltaText('d', 'delta-1', 'fp1'),
    ];
    const a = await eng.assemble(providers);
    expect(a.prompt.indexOf('static-hello')).toBeLessThan(a.prompt.indexOf('delta-1'));
    expect(a.manifest.cacheHitRatio).toBe(0);

    const b = await eng.assemble(providers);
    expect(b.manifest.cacheHitChars).toBeGreaterThan(0);
    expect(b.manifest.cacheHitRatio).toBeGreaterThan(0.5);
  });
});

describe('AttentionAccumulator', () => {
  beforeEach(() => {
    _resetAttentionAccumulator();
    redisLists.clear();
  });

  it('keeps burst messages instead of overwriting', async () => {
    const acc = new AttentionAccumulator();
    await acc.ingestAsync({ chatId: 1, layer: 'L0', reason: 'a', messageId: 1 });
    await acc.ingestAsync({ chatId: 1, layer: 'L0', reason: 'b', messageId: 2 });
    expect(await acc.size()).toBe(2);
    const flushed = await acc.flush(10);
    expect(flushed).toHaveLength(2);
  });

  it('flushes highest pressure first', async () => {
    const acc = new AttentionAccumulator();
    await acc.ingestAsync({ chatId: 1, layer: 'L2', reason: 'passive' });
    await acc.ingestAsync({ chatId: 2, layer: 'L0', reason: 'direct', messageId: 9 });
    const flushed = await acc.flush(1);
    expect(flushed).toHaveLength(1);
    expect(flushed[0]!.layer).toBe('L0');
    expect(await acc.size()).toBe(1);
  });
});

describe('MetaSandbox', () => {
  it('runs sync code with injected API', () => {
    const box = new MetaSandbox({
      add: (a: number, b: number) => a + b,
    });
    const r = box.execute('add(2, 40)');
    expect(r.error).toBe(false);
    expect(r.output).toContain('42');
  });
});

describe('GlobalState', () => {
  beforeEach(() => _resetGlobalState());

  it('keeps digests and callbacks', async () => {
    const s = getGlobalState();
    s.addDigest('hello');
    await s.enqueueCallbackAsync({
      id: 'c1',
      taskId: 't1',
      chatId: -100,
      summary: 'replied',
      ok: true,
      createdAt: Date.now(),
    });
    expect(s.recentDigests(1)[0]!.text).toBe('hello');
    expect(await s.drainCallbacks()).toHaveLength(1);
    expect(await s.drainCallbacks()).toHaveLength(0);
  });
});
