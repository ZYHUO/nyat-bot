import { describe, it, expect, beforeEach, vi } from 'vitest';

// in-memory list store
const lists = new Map<string, string[]>();
const redisMock = {
  lpush: vi.fn(async (k: string, v: string) => {
    const arr = lists.get(k) ?? [];
    arr.unshift(v);
    lists.set(k, arr);
    return arr.length;
  }),
  ltrim: vi.fn(async (k: string, start: number, stop: number) => {
    const arr = lists.get(k) ?? [];
    lists.set(k, arr.slice(start, stop + 1));
    return 'OK';
  }),
  lrange: vi.fn(async (k: string, start: number, stop: number) => {
    const arr = lists.get(k) ?? [];
    return arr.slice(start, stop + 1);
  }),
  expire: vi.fn(async () => 1),
  pipeline: () => {
    const ops: Array<() => Promise<unknown>> = [];
    const p: Record<string, unknown> = {
      lpush: (k: string, v: string) => { ops.push(() => redisMock.lpush(k, v)); return p; },
      ltrim: (k: string, a: number, b: number) => { ops.push(() => redisMock.ltrim(k, a, b)); return p; },
      expire: (k: string, ttl: number) => { ops.push(() => redisMock.expire(k, ttl)); return p; },
      exec: async () => { for (const op of ops) await op(); return []; },
    };
    return p;
  },
};
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => redisMock }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  appendGateHistory,
  getGateHistory,
  formatGateHistoryBlock,
  type GateHistEntry,
} from '../../../src/pipeline/timing/gate-history.js';

const KEY = 'xxb:timing:gatehist:-100';

beforeEach(() => {
  lists.clear();
  redisMock.expire.mockClear();
});

describe('gate-history 环形缓冲', () => {
  it('append 裁剪到最近 5 条并设 TTL', async () => {
    for (let i = 0; i < 7; i++) {
      await appendGateHistory(-100, { action: 'continue', reason: `r${i}`, ts: i });
    }
    const raw = lists.get(KEY)!;
    expect(raw).toHaveLength(5);
    // 新→旧:r6 在最前
    expect(JSON.parse(raw[0]!).reason).toBe('r6');
    expect(JSON.parse(raw[4]!).reason).toBe('r2');
    expect(redisMock.expire).toHaveBeenCalled();
  });

  it('getGateHistory 跳过坏条目', async () => {
    await appendGateHistory(-100, { action: 'wait', waitSec: 30, reason: 'ok', ts: 100 });
    lists.get(KEY)!.push('not-json', '{"action":"bogus","ts":1}');
    const hist = await getGateHistory(-100);
    expect(hist).toHaveLength(1);
    expect(hist[0]!.action).toBe('wait');
  });

  it('redis 故障 → 空历史(fail-open)', async () => {
    redisMock.lrange.mockRejectedValueOnce(new Error('down'));
    expect(await getGateHistory(-100)).toEqual([]);
  });
});

describe('formatGateHistoryBlock', () => {
  it('空历史 → undefined', () => {
    expect(formatGateHistoryBlock([])).toBeUndefined();
  });

  it('渲染相对时间 + wait 秒数 + 理由截断', () => {
    const now = 1_000_000_000_000;
    const entries: GateHistEntry[] = [
      { action: 'no_action', reason: '群友在自己聊', ts: now - 38_000 },
      { action: 'wait', waitSec: 30, reason: 'TA话没说完', ts: now - 5 * 60_000 },
      { action: 'continue', reason: '', ts: now - 2 * 3600_000 },
    ];
    const block = formatGateHistoryBlock(entries, now)!;
    expect(block).toContain('[最近节奏决策]');
    expect(block).toContain('38秒前 no_action:「群友在自己聊」');
    expect(block).toContain('5分钟前 wait(30s):「TA话没说完」');
    expect(block).toContain('2小时前 continue');
  });
});
