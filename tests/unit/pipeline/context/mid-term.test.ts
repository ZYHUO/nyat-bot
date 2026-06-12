import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── In-memory Redis(list + kv)──
const lists = new Map<string, string[]>();
const kv = new Map<string, string>();

const redisMock = {
  llen: vi.fn(async (k: string) => (lists.get(k) ?? []).length),
  lrange: vi.fn(async (k: string, a: number, b: number) => {
    const l = lists.get(k) ?? [];
    const end = b < 0 ? l.length + b : b;
    return l.slice(a, end + 1);
  }),
  set: vi.fn(async (k: string, v: string, ...args: unknown[]) => {
    if (args.includes('NX') && kv.has(k)) return null;
    kv.set(k, v);
    return 'OK';
  }),
  del: vi.fn(async (...ks: string[]) => {
    let n = 0;
    for (const k of ks) {
      if (kv.delete(k) || lists.delete(k)) n++;
    }
    return n;
  }),
  rpush: vi.fn(async (k: string, v: string) => {
    const l = lists.get(k) ?? [];
    l.push(v);
    lists.set(k, l);
    return l.length;
  }),
  ltrim: vi.fn(async (k: string, a: number, b: number) => {
    const l = lists.get(k) ?? [];
    const start = a < 0 ? Math.max(0, l.length + a) : a;
    const end = b < 0 ? l.length + b : b;
    lists.set(k, l.slice(start, end + 1));
    return 'OK';
  }),
  expire: vi.fn(async () => 1),
  // guarded LTRIM Lua:头部没变才裁
  eval: vi.fn(async (_script: string, _nk: number, key: string, expectedFirst: string, chunkStr: string) => {
    const l = lists.get(key) ?? [];
    if (l[0] === expectedFirst) {
      lists.set(key, l.slice(Number(chunkStr)));
      return 1;
    }
    return 0;
  }),
  pipeline: () => {
    const ops: Array<() => Promise<unknown>> = [];
    const p: Record<string, unknown> = {
      rpush: (k: string, v: string) => { ops.push(() => redisMock.rpush(k, v)); return p; },
      ltrim: (k: string, a: number, b: number) => { ops.push(() => redisMock.ltrim(k, a, b)); return p; },
      expire: (k: string, t: number) => { ops.push(() => redisMock.expire(k, t)); return p; },
      exec: async () => { for (const op of ops) await op(); return []; },
    };
    return p;
  },
};

vi.mock('../../../../src/db/redis.js', () => ({ getRedis: () => redisMock }));
vi.mock('../../../../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../../src/shared/config.js', () => ({
  loadPrompt: () => 'system',
  getConfig: () => ({ promptsDir: '/x' }),
}));

const callWithFallbackMock = vi.hoisted(() => vi.fn());
vi.mock('../../../../src/ai/fallback.js', () => ({ callWithFallback: callWithFallbackMock }));

const envValues: Record<string, unknown> = {
  MTM_ENABLED: true,
  CONTEXT_MAX_LENGTH: 400,
  MTM_CHUNK: 150,
  MTM_MAX_SUMMARIES: 3,
  MTM_INPUT_MAX_CHARS: 16000,
};
vi.mock('../../../../src/env.js', () => ({ env: () => envValues }));

import { maybeCompressMidTerm, getMidTermBlock } from '../../../../src/pipeline/context/mid-term.js';

const CHAT = -100555;
const CTX_KEY = `xxb:ctx:${CHAT}`;
const MTM_KEY = `xxb:mtm:${CHAT}`;

function fillCtx(n: number): void {
  const l: string[] = [];
  for (let i = 0; i < n; i++) {
    l.push(JSON.stringify({
      role: i % 5 === 0 ? 'assistant' : 'user',
      uid: 1000 + i,
      fullName: `u${i}`,
      timestamp: 1781000000 + i * 60,
      messageId: i + 1,
      textContent: `msg ${i}`,
    }));
  }
  lists.set(CTX_KEY, l);
}

describe('mid-term memory', () => {
  beforeEach(() => {
    lists.clear();
    kv.clear();
    vi.clearAllMocks();
    envValues['MTM_ENABLED'] = true;
    callWithFallbackMock.mockResolvedValue({ content: '群里在聊代理协议,小明宣布退群又回来了' });
  });

  it('低于阈值不触发压缩', async () => {
    fillCtx(200);
    await maybeCompressMidTerm(CHAT);
    expect(callWithFallbackMock).not.toHaveBeenCalled();
  });

  it('达到阈值:压缩最老一段,摘要入库,原文被裁', async () => {
    fillCtx(385); // threshold = 400 - 20 = 380
    await maybeCompressMidTerm(CHAT);

    expect(callWithFallbackMock).toHaveBeenCalledTimes(1);
    expect(lists.get(MTM_KEY)).toHaveLength(1);
    const entry = JSON.parse(lists.get(MTM_KEY)![0]!) as { summary: string; count: number };
    expect(entry.summary).toContain('小明');
    expect(entry.count).toBe(150);
    // ctx 头部 150 条被裁掉
    expect(lists.get(CTX_KEY)).toHaveLength(385 - 150);
    expect(JSON.parse(lists.get(CTX_KEY)![0]!).messageId).toBe(151);
  });

  it('压缩期间头部被内建 trim 动过 → 放弃裁剪,摘要照存', async () => {
    fillCtx(385);
    callWithFallbackMock.mockImplementation(async () => {
      // LLM 调用期间,内建 trim 抢先丢掉头部 10 条
      lists.set(CTX_KEY, lists.get(CTX_KEY)!.slice(10));
      return { content: '摘要' };
    });
    await maybeCompressMidTerm(CHAT);

    expect(lists.get(MTM_KEY)).toHaveLength(1);
    // 没有二次裁剪:长度只少了内建 trim 的 10 条
    expect(lists.get(CTX_KEY)).toHaveLength(375);
  });

  it('摘要 FIFO 上限:超出丢最老', async () => {
    lists.set(MTM_KEY, ['{"summary":"old1","fromTs":1,"toTs":2,"count":9,"createdAt":1}',
      '{"summary":"old2","fromTs":3,"toTs":4,"count":9,"createdAt":2}',
      '{"summary":"old3","fromTs":5,"toTs":6,"count":9,"createdAt":3}']);
    fillCtx(385);
    await maybeCompressMidTerm(CHAT);
    const l = lists.get(MTM_KEY)!;
    expect(l).toHaveLength(3); // MTM_MAX_SUMMARIES=3
    expect(l[0]).toContain('old2'); // old1 被挤出
  });

  it('锁被占用时跳过(不并发压缩)', async () => {
    fillCtx(385);
    kv.set(`xxb:mtm:lock:${CHAT}`, '1');
    await maybeCompressMidTerm(CHAT);
    expect(callWithFallbackMock).not.toHaveBeenCalled();
  });

  it('flag off:压缩与注入都是 no-op', async () => {
    envValues['MTM_ENABLED'] = false;
    fillCtx(385);
    await maybeCompressMidTerm(CHAT);
    expect(callWithFallbackMock).not.toHaveBeenCalled();
    expect(await getMidTermBlock(CHAT)).toBeNull();
  });

  it('getMidTermBlock 渲染编号摘要', async () => {
    lists.set(MTM_KEY, [JSON.stringify({
      summary: '大家聊了机场倒闭', fromTs: 1781000000, toTs: 1781003600, count: 150, createdAt: 1,
    })]);
    const block = await getMidTermBlock(CHAT);
    expect(block).toContain('1. (');
    expect(block).toContain('150条');
    expect(block).toContain('机场倒闭');
  });
});
