import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

let testDb: Database.Database;
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => testDb }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const envValues: Record<string, unknown> = {};
vi.mock('../../../src/env.js', () => ({ env: () => envValues }));

const { callWithFallbackMock, getRecentMock, zrangeMock, redisKv } = vi.hoisted(() => ({
  callWithFallbackMock: vi.fn(),
  getRecentMock: vi.fn(async (): Promise<Array<Record<string, unknown>>> => []),
  zrangeMock: vi.fn(async (): Promise<string[]> => []),
  redisKv: new Map<string, string>(),
}));
vi.mock('../../../src/ai/fallback.js', () => ({ callWithFallback: callWithFallbackMock }));
vi.mock('../../../src/pipeline/context/manager.js', () => ({ getRecent: getRecentMock }));
vi.mock('../../../src/db/redis.js', () => ({
  getRedis: () => ({
    zrange: zrangeMock,
    get: async (k: string) => redisKv.get(k) ?? null,
    set: async (k: string, v: string) => { redisKv.set(k, v); return 'OK'; },
    del: async (...ks: string[]) => { let n = 0; for (const k of ks) if (redisKv.delete(k)) n++; return n; },
  }),
}));

import { reflectChat, runDeepReflection, getChatReflection } from '../../../src/cron/deep-reflection.js';

function msgs(n: number): Array<Record<string, unknown>> {
  return Array.from({ length: n }, (_, i) => ({ uid: 100 + i, fullName: `U${i}`, textContent: `消息内容${i}`, isBot: false, timestamp: i }));
}

beforeEach(() => {
  testDb = new Database(':memory:');
  testDb.exec(readFileSync(resolve(process.cwd(), 'migrations/0049_chat_reflection.sql'), 'utf-8'));
  for (const k of Object.keys(envValues)) delete envValues[k];
  Object.assign(envValues, {
    REFLECTION_ENABLED: true, REFLECTION_INTERVAL_MIN: 30, REFLECTION_CHATS_PER_TICK: 20,
    REFLECTION_WINDOW_MSGS: 250, REFLECTION_USAGE: 'summarize',
  });
  vi.clearAllMocks();
  redisKv.clear();
  getRecentMock.mockResolvedValue([]);
  zrangeMock.mockResolvedValue([]);
  callWithFallbackMock.mockResolvedValue({ content: '本群最近在聊显卡和原神,氛围活跃,有个"光帆拉"的梗。' });
});

describe('reflectChat', () => {
  it('足够消息 → LLM 摘要写入 chat_reflection,可读回', async () => {
    getRecentMock.mockResolvedValue(msgs(40));
    const tok = await reflectChat(-1001);
    expect(tok).toBeGreaterThan(0);
    expect(getChatReflection(-1001)).toContain('光帆拉');
  });

  it('消息太少 → 不反思(不调 LLM)', async () => {
    getRecentMock.mockResolvedValue(msgs(5));
    const tok = await reflectChat(-1001);
    expect(tok).toBe(0);
    expect(callWithFallbackMock).not.toHaveBeenCalled();
  });

  it('二次反思覆盖(ON CONFLICT),单行', async () => {
    getRecentMock.mockResolvedValue(msgs(40));
    await reflectChat(-1001);
    callWithFallbackMock.mockResolvedValue({ content: '新的近况摘要在此,内容更新了一版' });
    await reflectChat(-1001);
    expect(getChatReflection(-1001)).toBe('新的近况摘要在此,内容更新了一版');
    const cnt = (testDb.prepare('SELECT COUNT(*) c FROM chat_reflection WHERE chat_id=-1001').get() as { c: number }).c;
    expect(cnt).toBe(1);
  });

  it('LLM 输出太短 → 不写', async () => {
    getRecentMock.mockResolvedValue(msgs(40));
    callWithFallbackMock.mockResolvedValue({ content: '短' });
    expect(await reflectChat(-1001)).toBe(0);
    expect(getChatReflection(-1001)).toBeNull();
  });

  it('LLM 链全灭 → 进失败冷却,冷却中不再调 LLM;成功后冷却清除', async () => {
    getRecentMock.mockResolvedValue(msgs(40));
    callWithFallbackMock.mockRejectedValue(new Error('All labels exhausted'));
    expect(await reflectChat(-1001)).toBe(0);
    expect(callWithFallbackMock).toHaveBeenCalledTimes(1);
    expect(redisKv.get('xxb:reflect:fail:-1001')).toBe('1');

    // 冷却中:直接跳过,不再烧链
    expect(await reflectChat(-1001)).toBe(0);
    expect(callWithFallbackMock).toHaveBeenCalledTimes(1);

    // 链恢复后(冷却过期/被成功清除)正常反思
    redisKv.clear();
    callWithFallbackMock.mockResolvedValue({ content: '本群最近在聊显卡和原神,氛围活跃,有个"光帆拉"的梗。' });
    expect(await reflectChat(-1001)).toBeGreaterThan(0);
    expect(redisKv.has('xxb:reflect:fail:-1001')).toBe(false);
  });
});

describe('runDeepReflection', () => {
  it('只反思活跃群(负 chatId),正数被过滤', async () => {
    zrangeMock.mockResolvedValue(['-1001', '42', '-1002']); // 42 是 DM,不该反思
    getRecentMock.mockResolvedValue(msgs(40));
    await runDeepReflection();
    // getRecent 只该被两个群调用
    expect(getRecentMock).toHaveBeenCalledTimes(2);
    expect(getChatReflection(-1001)).toBeTruthy();
    expect(getChatReflection(-1002)).toBeTruthy();
    expect(getChatReflection(42)).toBeNull();
  });

  it('flag 关 → 不跑', async () => {
    envValues['REFLECTION_ENABLED'] = false;
    zrangeMock.mockResolvedValue(['-1001']);
    await runDeepReflection();
    expect(getRecentMock).not.toHaveBeenCalled();
  });
});
