import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import Redis from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ redis: null as unknown, llm: vi.fn(), budget: 16000 }));
vi.mock('../../../../src/db/redis.js', () => ({ getRedis: () => fixture.redis }));
vi.mock('../../../../src/env.js', () => ({ env: () => ({ BOT_TOKEN: '12345:test-only', MTM_ENABLED: true, CONTEXT_MAX_LENGTH: 25, MTM_CHUNK: 3, MTM_MAX_SUMMARIES: 3, MTM_INPUT_MAX_CHARS: fixture.budget }) }));
vi.mock('../../../../src/ai/fallback.js', () => ({ callWithFallback: fixture.llm }));
vi.mock('../../../../src/shared/config.js', () => ({ getConfig: () => ({ promptsDir: '' }), loadPrompt: () => 'summarize synthetic history' }));
vi.mock('../../../../src/shared/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('../../../../src/pipeline/context/manager.js', () => ({ readScopedNyatContext: () => null }));
import { contextRedisKey, contextStorageKey, resolveStorageScope } from '../../../../src/pipeline/context/storage-scope.js';
import { getMidTermBlock, maybeCompressMidTerm } from '../../../../src/pipeline/context/mid-term.js';

// Explicit opt-in: fresh port=0/socket-only server, never existing REDIS_URL/data.
const serverPath = process.env['NYATBOT_TEST_REDIS_SERVER'];
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
describe.skipIf(!serverPath)('MTM coverage against actual isolated Redis Lua', () => {
  let child: ChildProcess | undefined, dir: string | undefined, redis: Redis;
  const chat = -987654;
  const scope = resolveStorageScope(chat)!;
  const key = contextRedisKey(scope);
  const mtm = `xxb:mtm:v3:${contextStorageKey(scope)}`;
  const entries = Array.from({ length: 8 }, (_, i) => JSON.stringify({ contextScope: scope, role: 'user', uid: 77, fullName: '合成作者', textContent: `合成内容 ${i}`, messageId: i + 1, timestamp: 1000 + i }));
  beforeAll(async () => {
    if (!serverPath || !isAbsolute(serverPath)) throw new Error('Test Redis path must be absolute');
    dir = await mkdtemp(join(tmpdir(), 'nyat-mtm-test-'));
    const socket = join(dir, 'redis.sock');
    let startupError: Error | undefined;
    child = spawn(serverPath, ['--port', '0', '--unixsocket', socket, '--unixsocketperm', '700', '--save', '', '--appendonly', 'no', '--dir', dir], { stdio: 'ignore' });
    child.once('error', err => { startupError = err; });
    for (let i = 0; i < 150 && !existsSync(socket); i++) {
      if (startupError) throw startupError;
      if (child.exitCode !== null) throw new Error('Test Redis exited');
      await pause(20);
    }
    if (!existsSync(socket)) throw new Error('Test Redis socket missing');
    redis = new Redis(socket, { lazyConnect: true, enableOfflineQueue: false, retryStrategy: () => null, maxRetriesPerRequest: 0, connectTimeout: 1000 });
    redis.on('error', () => {});
    await redis.connect();
    fixture.redis = redis;
  }, 5000);
  beforeEach(async () => {
    await redis.flushdb();
    await redis.rpush(key, ...entries);
    fixture.budget = 16000;
    fixture.llm.mockReset().mockResolvedValue({ content: '合成摘要：未完成的需求仍需处理' });
  });
  afterAll(async () => {
    redis?.disconnect();
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      for (let i = 0; i < 50 && child.exitCode === null && child.signalCode === null; i++) await pause(20);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    if (dir && dirname(resolve(dir)) === resolve(tmpdir()) && dir.includes('nyat-mtm-test-')) await rm(dir, { recursive: true, force: true });
  });
  it('atomically stores a scoped summary and removes exactly the complete input prefix', async () => {
    fixture.budget = 100;
    await maybeCompressMidTerm(chat);
    const raw = await redis.lrange(mtm, 0, -1);
    expect(raw).toHaveLength(1);
    const entry = JSON.parse(raw[0]!);
    expect(entry.count).toBe(1);
    expect(await redis.lrange(key, 0, -1)).toEqual(entries.slice(1));
    expect(await getMidTermBlock(chat)).toContain('platform=telegram');
    expect(await redis.ttl(mtm)).toBeGreaterThan(0);
  });
  it('rejects an edited interior message even when the head has not moved', async () => {
    fixture.llm.mockImplementation(async () => {
      await redis.lset(key, 1, JSON.stringify({ ...JSON.parse(entries[1]!), textContent: '新的纠正' }));
      return { content: '旧快照摘要不可提交' };
    });
    await maybeCompressMidTerm(chat);
    expect(await redis.llen(key)).toBe(8);
    expect(await redis.llen(mtm)).toBe(0);
  });
});
