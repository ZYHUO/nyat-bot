import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── In-memory Redis(list + kv)──
const lists = new Map<string, string[]>();
const kv = new Map<string, string>();

const redisMock = {
  get: vi.fn(async (k: string) => kv.get(k) ?? null),
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
  // guarded compress Lua:头部没变 → 裁 ctx + 存摘要 + FIFO 截断(原子)
  eval: vi.fn(async (
    _script: string, _nk: number,
    ctxKey: string, mtmKey: string,
    expectedFirst: string, chunkStr: string, summaryJson: string, maxStr: string, _ttl: string, expectedJson: string,
  ) => {
    const l = lists.get(ctxKey) ?? [];
    const expected = JSON.parse(expectedJson) as string[];
    if (l[0] === expectedFirst && expected.every((value, index) => l[index] === value)) {
      lists.set(ctxKey, l.slice(Number(chunkStr)));
      const m = lists.get(mtmKey) ?? [];
      m.push(summaryJson);
      lists.set(mtmKey, m.slice(-Number(maxStr)));
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
  BOT_TOKEN: '12345:test-only',
  MTM_ENABLED: true,
  CONTEXT_MAX_LENGTH: 400,
  MTM_CHUNK: 150,
  MTM_MAX_SUMMARIES: 3,
  MTM_INPUT_MAX_CHARS: 16000,
};
vi.mock('../../../../src/env.js', () => ({ env: () => envValues }));
vi.mock('../../../../src/nyatdb/index.js', () => ({
  getNyatDb: () => null,
  unpackChatLogRow: () => ({}),
}));

import { maybeCompressMidTerm, getMidTermBlock } from '../../../../src/pipeline/context/mid-term.js';
import { resolveContextScope } from '../../../../src/context-engine/scope.js';

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
    envValues['MTM_INPUT_MAX_CHARS'] = 16000;
    envValues['MTM_CHUNK'] = 150;
    callWithFallbackMock.mockResolvedValue({ content: '群里在聊代理协议,小明宣布退群又回来了' });
  });

  it('NyatDB 独占 ctx 时跳过 Redis 中期压缩', async () => {
    envValues['NYATDB_ENABLED'] = true;
    envValues['NYATDB_DUAL_WRITE'] = true;
    envValues['NYATDB_REDIS_MIRROR'] = false;
    fillCtx(400);
    await maybeCompressMidTerm(CHAT);
    expect(callWithFallbackMock).not.toHaveBeenCalled();
    delete envValues['NYATDB_ENABLED'];
    delete envValues['NYATDB_DUAL_WRITE'];
    delete envValues['NYATDB_REDIS_MIRROR'];
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

  it('压缩期间头部被内建 trim 动过 → 整轮丢弃,不存摘要(防同批重压出重复摘要)', async () => {
    fillCtx(385);
    callWithFallbackMock.mockImplementation(async () => {
      // LLM 调用期间,内建 trim 抢先丢掉头部 10 条
      lists.set(CTX_KEY, lists.get(CTX_KEY)!.slice(10));
      return { content: '摘要' };
    });
    await maybeCompressMidTerm(CHAT);

    // 摘要不入库(否则下一轮重压同批消息 → 重复摘要,上线首日实测)
    expect(lists.get(MTM_KEY) ?? []).toHaveLength(0);
    // 也没有二次裁剪:长度只少了内建 trim 的 10 条
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

  it('LLM 链全灭 → 进失败冷却,冷却中每条消息不再白烧链;成功后冷却清除', async () => {
    fillCtx(385);
    callWithFallbackMock.mockRejectedValue(new Error('All labels exhausted'));
    await maybeCompressMidTerm(CHAT);
    expect(callWithFallbackMock).toHaveBeenCalledTimes(1);
    expect(kv.get(`xxb:mtm:fail:${CHAT}`)).toBe('1');
    // 原文未被裁(压缩没发生)
    expect(lists.get(CTX_KEY)).toHaveLength(385);

    // 冷却中:再来消息直接跳过
    await maybeCompressMidTerm(CHAT);
    expect(callWithFallbackMock).toHaveBeenCalledTimes(1);

    // 链恢复(冷却过期)后正常压缩,冷却键被清除
    kv.delete(`xxb:mtm:fail:${CHAT}`);
    callWithFallbackMock.mockResolvedValue({ content: '群里在聊代理协议,小明宣布退群又回来了' });
    await maybeCompressMidTerm(CHAT);
    expect(callWithFallbackMock).toHaveBeenCalledTimes(2);
    expect(lists.get(MTM_KEY)).toHaveLength(1);
    expect(kv.has(`xxb:mtm:fail:${CHAT}`)).toBe(false);
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
      version: 2, source: resolveContextScope(CHAT), anchors: ['mid=149 uid=7: 尚未回答的问题？'],
      summary: '大家聊了机场倒闭', fromTs: 1781000000, toTs: 1781003600, count: 150, createdAt: 1,
    })]);
    const block = await getMidTermBlock(CHAT);
    expect(block).toContain('1. (');
    expect(block).toContain('150条');
    expect(block).toContain('机场倒闭');
  });

  it('拒绝旧无来源摘要和错误平台/账号/会话/话题的摘要，不删除存量', async () => {
    const valid = { version: 2, source: resolveContextScope(CHAT), anchors: [], summary: 'PRIVATE_SYNTHETIC', fromTs: 1, toTs: 2, count: 3, createdAt: 1 };
    for (const patch of [
      { source: undefined }, { version: 1 },
      { source: { ...valid.source, platform: 'qq' } },
      { source: { ...valid.source, accountId: '54321' } },
      { source: { ...valid.source, chatId: CHAT - 1 } },
      { source: { ...valid.source, threadId: 7 } },
    ]) {
      const raw = JSON.stringify({ ...valid, ...patch });
      lists.set(MTM_KEY, [raw]);
      expect(await getMidTermBlock(CHAT)).toBeNull();
      expect(lists.get(MTM_KEY)).toEqual([raw]);
    }
  });

  it('预算只归档完整输入前缀；被预算挡住的消息原样留在上下文', async () => {
    fillCtx(385);
    const original = [...lists.get(CTX_KEY)!];
    envValues['MTM_INPUT_MAX_CHARS'] = 300;
    await maybeCompressMidTerm(CHAT);
    const entry = JSON.parse(lists.get(MTM_KEY)![0]!) as { count: number };
    expect(entry.count).toBeGreaterThan(0);
    expect(entry.count).toBeLessThan(150);
    expect(lists.get(CTX_KEY)).toEqual(original.slice(entry.count));
    const input = callWithFallbackMock.mock.calls[0]![0].messages[1].content as string;
    for (const raw of original.slice(0, entry.count)) expect(input).toContain(JSON.parse(raw).textContent);
    expect(input.length).toBeLessThanOrEqual(300);
  });

  it('第一条超预算或损坏时不删后续消息、不假称已归档', async () => {
    fillCtx(385);
    const original = [...lists.get(CTX_KEY)!];
    envValues['MTM_INPUT_MAX_CHARS'] = 10;
    await maybeCompressMidTerm(CHAT);
    expect(callWithFallbackMock).not.toHaveBeenCalled();
    expect(lists.get(CTX_KEY)).toEqual(original);
    lists.get(CTX_KEY)![0] = 'bad-json';
    envValues['MTM_INPUT_MAX_CHARS'] = 16000;
    await maybeCompressMidTerm(CHAT);
    expect(lists.get(CTX_KEY)).toHaveLength(385);
    expect(lists.has(MTM_KEY)).toBe(false);
  });

  it('保留长文本尾部纠正、作者、@和引用，不依赖模型复述', async () => {
    fillCtx(385);
    envValues['MTM_CHUNK'] = 3;
    const m = JSON.parse(lists.get(CTX_KEY)![2]!);
    m.textContent = '长背景'.repeat(100) + '@机器人 纠正：不要公开图片；最后那个问题还没回答？';
    m.replyTo = { messageId: 19, uid: 88, fullName: '原作者', textSnippet: '还没完成的需求' };
    lists.get(CTX_KEY)![2] = JSON.stringify(m);
    await maybeCompressMidTerm(CHAT);
    const input = callWithFallbackMock.mock.calls[0]![0].messages[1].content as string;
    expect(input).toContain(m.textContent);
    expect(input).toContain('"uid":88');
    const block = await getMidTermBlock(CHAT);
    expect(block).toContain('最后那个问题还没回答');
    expect(block).toContain('uid=1002');
    expect(block).toContain('"mid":19');
  });

  it('话题压缩读取和存储保持同源，不能读取General或其他话题摘要', async () => {
    fillCtx(385);
    lists.set(`${CTX_KEY}:t7`, [...lists.get(CTX_KEY)!]);
    await maybeCompressMidTerm(CHAT, 7);
    expect(lists.get(CTX_KEY)).toHaveLength(385);
    expect(await getMidTermBlock(CHAT)).toBeNull();
    expect(await getMidTermBlock(CHAT, 8)).toBeNull();
    expect(await getMidTermBlock(CHAT, 7)).toContain('topic=7');
  });

  it('压缩期间中间条目被编辑也不裁剪旧快照', async () => {
    fillCtx(385);
    callWithFallbackMock.mockImplementationOnce(async () => {
      const changed = JSON.parse(lists.get(CTX_KEY)![20]!);
      changed.textContent = '新的纠正';
      lists.get(CTX_KEY)![20] = JSON.stringify(changed);
      return { content: '不能提交的旧摘要' };
    });
    await maybeCompressMidTerm(CHAT);
    expect(lists.get(CTX_KEY)).toHaveLength(385);
    expect(lists.get(MTM_KEY) ?? []).toHaveLength(0);
  });
});
