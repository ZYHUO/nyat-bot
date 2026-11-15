import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import Redis from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { acquireAiLease, aiLeaseKeys } from '../../../src/ai/workload.js';

// Opt-in integration test. Only a newly spawned port=0 Unix-socket Redis is used;
// REDIS_URL, application getRedis(), existing ports and existing data are never read.
// NYATBOT_TEST_REDIS_SERVER=/absolute/path/redis-server npx vitest run tests/unit/ai/workload-redis.test.ts
const serverPath = process.env['NYATBOT_TEST_REDIS_SERVER'];
const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

describe.skipIf(!serverPath)('AI leases against isolated Redis Lua', () => {
  let child: ChildProcess | undefined;
  let dir: string | undefined;
  let redis: Redis | undefined;
  const options = { model: 'shared-model', workload: 'interactive' as const, totalLimit: 2, backgroundLimit: 1, timeoutMs: 60_000 };
  const client = (): Redis => {
    if (!redis) throw new Error('Isolated Redis is not ready');
    return redis;
  };
  const acquire = (overrides: Partial<Parameters<typeof acquireAiLease>[1]> = {}) =>
    acquireAiLease(client(), { ...options, ...overrides });

  beforeAll(async () => {
    if (!serverPath || !isAbsolute(serverPath)) throw new Error('Test Redis path must be absolute');
    dir = await mkdtemp(join(tmpdir(), 'nyat-ai-lease-'));
    const socket = join(dir, 'redis.sock');
    let startupError: Error | undefined;
    child = spawn(serverPath, ['--port', '0', '--unixsocket', socket, '--unixsocketperm', '700',
      '--save', '', '--appendonly', 'no', '--dir', dir], { stdio: 'ignore' });
    child.once('error', err => { startupError = err; });
    for (let i = 0; i < 150 && !existsSync(socket); i++) {
      if (startupError) throw startupError;
      if (child.exitCode !== null) throw new Error(`Isolated Redis exited: ${child.exitCode}`);
      await pause(20);
    }
    if (!existsSync(socket)) throw new Error('Isolated Redis socket was not created');
    redis = new Redis(socket, { lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 0,
      retryStrategy: () => null, connectTimeout: 1000 });
    redis.on('error', () => {});
    await redis.connect();
  }, 5000);

  beforeEach(async () => { await client().flushdb(); });

  afterAll(async () => {
    redis?.disconnect();
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      for (let i = 0; i < 50 && child.exitCode === null && child.signalCode === null; i++) await pause(20);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    // Only remove the unique direct child directory created above.
    if (dir && dirname(resolve(dir)) === resolve(tmpdir()) && dir.includes('nyat-ai-lease-')) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('atomically admits at most one background and two total under concurrent load', async () => {
    const attempts = await Promise.all(Array.from({ length: 20 }, (_, i) =>
      acquire({ workload: i % 2 ? 'interactive' : 'background' })));
    expect(attempts.filter(Boolean)).toHaveLength(2);
    const [all, background] = aiLeaseKeys(options.model);
    expect(await client().zcard(all)).toBe(2);
    expect(await client().zcard(background)).toBe(1);
    await Promise.all(attempts.map(lease => lease?.release()));
    expect(await client().zcard(all)).toBe(0);
    expect(await client().zcard(background)).toBe(0);
  });

  it('preserves an active background call when foreground takes the reserved slot', async () => {
    const background = await acquire({ workload: 'background' });
    expect(background).not.toBeNull();
    expect(await acquire({ workload: 'background' })).toBeNull();
    const interactive = await acquire();
    expect(interactive).not.toBeNull();
    expect(await acquire()).toBeNull();
    await interactive!.release();
    expect(await client().zcard(aiLeaseKeys(options.model)[1])).toBe(1);
    expect(await acquire({ workload: 'background' })).toBeNull();
    await background!.release();
  });

  it('allows foreground to use both slots when there is no background work', async () => {
    const first = await acquire();
    const second = await acquire();
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(await acquire({ workload: 'background' })).toBeNull();
    await first!.release();
    await second!.release();
  });

  it('does not let an expired release remove a replacement lease', async () => {
    const old = await acquire({ workload: 'background' });
    const keys = aiLeaseKeys(options.model);
    const [oldToken] = await client().zrange(keys[0], 0, -1);
    expect(oldToken).toBeDefined();
    // Advance only this lease's expiry, without sleeps or changing server time.
    await client().zadd(keys[0], 0, oldToken!);
    await client().zadd(keys[1], 0, oldToken!);
    const replacement = await acquire({ workload: 'background' });
    expect(replacement).not.toBeNull();
    await old!.release();
    expect(await client().zcard(keys[0])).toBe(1);
    expect(await client().zcard(keys[1])).toBe(1);
    expect(await acquire({ workload: 'background' })).toBeNull();
    await replacement!.release();
  });

  it('keeps a long timeout lease alive when a shorter lease arrives', async () => {
    const long = await acquire({ timeoutMs: 600_000 });
    const short = await acquire({ timeoutMs: 1000 });
    expect(await client().pttl(aiLeaseKeys(options.model)[0])).toBeGreaterThan(629_000);
    await short!.release();
    expect(await client().zcard(aiLeaseKeys(options.model)[0])).toBe(1);
    await long!.release();
  });

  it('makes release idempotent and isolates models', async () => {
    const lease = await acquire();
    const other = await acquire({ model: 'another-model' });
    await Promise.all([lease!.release(), lease!.release()]);
    expect(await client().zcard(aiLeaseKeys(options.model)[0])).toBe(0);
    expect(await client().zcard(aiLeaseKeys('another-model')[0])).toBe(1);
    await other!.release();
  });

  it('reserves the only slot for foreground when totalLimit is one', async () => {
    expect(await acquire({ workload: 'background', totalLimit: 1, backgroundLimit: 9 })).toBeNull();
    const foreground = await acquire({ totalLimit: 1 });
    expect(foreground).not.toBeNull();
    await foreground!.release();
  });
});
