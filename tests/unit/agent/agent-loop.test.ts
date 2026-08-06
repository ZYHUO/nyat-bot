import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- mock getRedis -------------------------------------------------------
const store = new Map<string, string>();
const listStore = new Map<string, string[]>();

const redisMock = {
  get: vi.fn(async (k: string) => store.get(k) ?? null),
  set: vi.fn(async (k: string, v: string, ...args: unknown[]) => {
    store.set(k, v);
    if (args[0] === 'EX' && typeof args[1] === 'number') {
      // TTL 不实际过期，测试内手动管理
    }
    return 'OK';
  }),
  del: vi.fn(async (...keys: string[]) => {
    for (const k of keys) {
      store.delete(k);
      listStore.delete(k);
    }
    return keys.length;
  }),
  expire: vi.fn(async () => 1),
  rpush: vi.fn(async (k: string, v: string) => {
    const arr = listStore.get(k) ?? [];
    arr.push(v);
    listStore.set(k, arr);
    return arr.length;
  }),
  lrange: vi.fn(async (k: string) => listStore.get(k) ?? []),
  ltrim: vi.fn(async (k: string, start: number, end: number) => {
    const arr = listStore.get(k) ?? [];
    listStore.set(k, arr.slice(start, end === -1 ? undefined : end + 1));
    return 'OK';
  }),
  llen: vi.fn(async (k: string) => (listStore.get(k) ?? []).length),
};

vi.mock('../../../src/db/redis.js', () => ({
  getRedis: () => redisMock,
}));

// ---- module under test ----------------------------------------------------
import { saveCheckpoint, loadCheckpoint, clearCheckpoint, checkpointKey } from '../../../src/agent/checkpoint.js';
import { compactHistory, restoreMessagesFromCompacted } from '../../../src/agent/compaction.js';
import { pushInterrupt, drainInterrupts, hasActiveInterrupts } from '../../../src/agent/interrupts.js';

// callWithFallback mock for compaction
vi.mock('../../../src/ai/fallback.js', () => ({
  callWithFallback: vi.fn(async () => ({
    content: JSON.stringify({
      summary: '已完成贪吃蛇核心逻辑，下一步接入键盘事件。卡点：canvas 刷新率。',
      artifacts: ['snake.html'],
    }),
  })),
}));

vi.mock('../../../src/env.js', () => ({
  env: () => ({
    AGENT_COMPACT_USAGE: 'judge',
    AGENT_LOOP_ENABLED: true,
    AGENT_MAX_SEGMENTS: 10,
    AGENT_COMPACT_AFTER_TURNS: 50,
  }),
}));

vi.mock('../../../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const makeTask = (overrides: Record<string, unknown> = {}) => ({
  id: 't1',
  chatId: -1001,
  contentDirection: '写个贪吃蛇',
  createdAt: Date.now(),
  status: 'queued' as const,
  ...overrides,
});

describe('agent checkpoint', () => {
  beforeEach(() => {
    store.clear();
    listStore.clear();
    vi.clearAllMocks();
  });

  it('save/load roundtrip preserves history and summary', async () => {
    const task = makeTask();
    const key = await saveCheckpoint(task, {
      history: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'u1' },
        { role: 'assistant', content: 'a1' },
      ],
      progressSummary: '做了第一步',
      artifacts: [],
      segment: 1,
      totalTurns: 12,
    });
    expect(key).toBe(checkpointKey('t1'));

    const cp = await loadCheckpoint(key);
    expect(cp).not.toBeNull();
    expect(cp!.taskId).toBe('t1');
    expect(cp!.contentDirection).toBe('写个贪吃蛇');
    expect(cp!.history).toHaveLength(3);
    expect(cp!.progressSummary).toBe('做了第一步');
    expect(cp!.segment).toBe(1);
    expect(cp!.totalTurns).toBe(12);
  });

  it('clearCheckpoint removes the key', async () => {
    const task = makeTask();
    const key = await saveCheckpoint(task, {
      history: [],
      progressSummary: '',
      artifacts: [],
      segment: 1,
      totalTurns: 0,
    });
    await clearCheckpoint(key);
    expect(await loadCheckpoint(key)).toBeNull();
  });

  it('loadCheckpoint returns null for missing key', async () => {
    expect(await loadCheckpoint('xxb:agent:checkpoint:nope')).toBeNull();
  });
});

describe('agent compaction', () => {
  beforeEach(() => {
    store.clear();
    listStore.clear();
    vi.clearAllMocks();
  });

  it('returns as-is when history is short (no LLM call)', async () => {
    const history = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
    ];
    const result = await compactHistory({
      history,
      progressSummary: '',
      contentDirection: '写个贪吃蛇',
    });
    expect(result.recent).toHaveLength(2);
    expect(result.summary).toBe('');
  });

  it('compacts long history with LLM summary', async () => {
    const history: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> = [
      { role: 'system', content: 'sys' },
    ];
    for (let i = 0; i < 30; i++) {
      history.push({ role: 'user', content: `step ${i}` });
      history.push({ role: 'assistant', content: `obs ${i}` });
    }
    const result = await compactHistory({
      history,
      progressSummary: '此前进度',
      contentDirection: '写个贪吃蛇',
    });
    // 16 轮保留 + 摘要
    expect(result.compactedTurns).toBeLessThanOrEqual(17);
    expect(result.summary).toContain('贪吃蛇');
    expect(result.summary).toContain('此前进度');
  });

  it('restoreMessagesFromCompacted keeps system + summary + recent', () => {
    const history: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> = [
      { role: 'system', content: 'sys' },
    ];
    for (let i = 0; i < 40; i++) {
      history.push({ role: 'user', content: `u${i}` });
      history.push({ role: 'assistant', content: `a${i}` });
    }
    const messages = restoreMessagesFromCompacted({
      history,
      progressSummary: '摘要内容',
    });
    // system + 摘要 + 确认 + 最近 16 轮
    expect(messages[0]!.role).toBe('system');
    expect(messages.some((m) => m.content.includes('摘要内容'))).toBe(true);
    expect(messages.length).toBeLessThan(20);
    // 最近一轮保留原文
    expect(messages[messages.length - 1]!.content).toBe('a39');
  });
});

describe('agent interrupts', () => {
  beforeEach(() => {
    store.clear();
    listStore.clear();
    vi.clearAllMocks();
  });

  it('push + drain roundtrip', async () => {
    await pushInterrupt('t1', { text: '进度咋样了', from: '@master', messageId: 42 });
    await pushInterrupt('t1', { text: '先停', from: '@master' });
    expect(await hasActiveInterrupts('t1')).toBe(true);

    const drained = await drainInterrupts('t1');
    expect(drained).toHaveLength(2);
    expect(drained[0]!.text).toBe('进度咋样了');
    expect(drained[0]!.from).toBe('@master');
    expect(drained[0]!.messageId).toBe(42);
    expect(drained[0]!.at).toBeGreaterThan(0);
    // drain 后清空
    expect(await hasActiveInterrupts('t1')).toBe(false);
  });

  it('drain on empty returns []', async () => {
    expect(await drainInterrupts('nope')).toEqual([]);
  });

  it('caps at MAX_INTERRUPTS (20)', async () => {
    for (let i = 0; i < 30; i++) {
      await pushInterrupt('t1', { text: `msg ${i}`, from: 'x' });
    }
    const drained = await drainInterrupts('t1');
    expect(drained.length).toBe(20);
    expect(drained[0]!.text).toBe('msg 10');
  });
});
