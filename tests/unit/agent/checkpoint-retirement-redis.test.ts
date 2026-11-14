import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import Redis from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DispatchTask } from '../../../src/meta/types.js';

const f = vi.hoisted(() => ({
  redis: null as unknown, tasks: new Map<string, DispatchTask>(), send: vi.fn(), collect: vi.fn(),
  config: { BOT_TOKEN: '12345:test-only', META_SUBAGENT_ENABLED: true, CODEACT_ISOLATION_ENABLED: true, META_SUBAGENT_CHAT_IDS: [] as number[], META_ACTIVATED_AT_SEC: 100 },
}));
vi.mock('../../../src/env.js', () => ({ env: () => f.config }));
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => f.redis }));
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => { throw new Error('unexpected_database_access'); } }));
vi.mock('../../../src/meta/global-state.js', () => ({ getGlobalState: () => ({ getTask: (id: string) => f.tasks.get(id), putTask: (task: DispatchTask) => f.tasks.set(task.id, task) }) }));
vi.mock('../../../src/subagent/prompt-inputs.js', () => ({ collectPromptInputs: f.collect }));
vi.mock('../../../src/bot/sender/telegram.js', () => ({ sendChatAction: f.send, sendMessage: f.send, sendSticker: f.send, reactToMessage: f.send }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() } }));
import { runCodeActTask } from '../../../src/subagent/executor.js';
import { getAgentTaskIdForChat, registerAgentChat, retireHeldCheckpointTask } from '../../../src/agent/checkpoint.js';
import { loadCodeActTask } from '../../../src/subagent/task-store.js';

// Opt-in, port=0 Unix-socket test server. Never reads existing REDIS_URL/data.
const serverPath = process.env['NYATBOT_TEST_REDIS_SERVER'];
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
describe.skipIf(!serverPath)('checkpoint hold retirement against isolated Redis and real executor', () => {
  let child: ChildProcess | undefined, dir: string | undefined, redis: Redis;
  const task = (): DispatchTask => ({ id: 'resumed', chatId: 42, createdAt: 101000, status: 'waiting_user', segment: 2,
    contentDirection: 'synthetic unfinished task', checkpointKey: 'xxb:agent:checkpoint:resumed', waitingForUser: true });
  const key = 'xxb:agent:active-chat:42', active = 'xxb:codeact:active:42';
  async function seed(t = task()): Promise<string> {
    const raw = JSON.stringify(t);
    await redis.hset('xxb:codeact:tasks', t.id, raw);
    await redis.set(key, t.id, 'EX', 86400);
    await redis.set(active, t.id, 'EX', 180);
    f.tasks.set(t.id, structuredClone(t));
    return raw;
  }
  beforeAll(async () => {
    if (!serverPath || !isAbsolute(serverPath)) throw new Error('Test Redis path must be absolute');
    dir = await mkdtemp(join(tmpdir(), 'nyat-cp-retire-'));
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
    f.redis = redis;
  }, 5000);
  beforeEach(async () => {
    vi.restoreAllMocks(); vi.clearAllMocks();
    f.redis = redis; f.tasks.clear(); f.config.META_SUBAGENT_ENABLED = true;
    await redis.flushdb();
  });
  afterAll(async () => {
    redis?.disconnect();
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      for (let i = 0; i < 50 && child.exitCode === null && child.signalCode === null; i++) await pause(20);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    if (dir && dirname(resolve(dir)) === resolve(tmpdir()) && dir.includes('nyat-cp-retire-')) await rm(dir, { recursive: true, force: true });
  });

  it('archives the original record, retires waiting state and releases the exact ingress index for a new task', async () => {
    const current = task(), raw = await seed(current);
    await runCodeActTask(current);
    expect(await getAgentTaskIdForChat(42)).toBeNull();
    expect(await redis.get(active)).toBeNull();
    expect(await loadCodeActTask(current.id)).toMatchObject({ status: 'failed', waitingForUser: false, resultSummary: 'held_checkpoint_missing' });
    expect(f.tasks.get(current.id)?.status).toBe('failed');
    const archive = Object.values(await redis.hgetall('xxb:codeact:checkpoint-held'));
    expect(archive).toHaveLength(1);
    expect(JSON.parse(archive[0]!).taskRaw).toBe(raw);
    expect(await redis.ttl('xxb:codeact:checkpoint-held')).toBe(-1);
    expect(await redis.hget('xxb:codeact:activation-held', current.id)).not.toBeNull();
    // These are the actual readers/writer used by Meta ingress, not a mocked route.
    await registerAgentChat(42, 'new-task');
    expect(await getAgentTaskIdForChat(42)).toBe('new-task');
    expect(f.send).not.toHaveBeenCalled(); expect(f.collect).not.toHaveBeenCalled();
  });

  it('same ID in another durable chat or a newer checkpoint is never modified', async () => {
    for (const mismatch of [{ chatId: 99 }, { checkpointKey: 'newer-checkpoint' }, { createdAt: 102000 }]) {
      await redis.flushdb();
      const original = { ...task(), ...mismatch }, raw = await seed(original);
      await runCodeActTask(task());
      expect(await redis.hget('xxb:codeact:tasks', original.id)).toBe(raw);
      expect(await redis.get(key)).toBe(original.id);
      expect(f.tasks.get(original.id)).toEqual(original);
      expect(await redis.hlen('xxb:codeact:checkpoint-held')).toBe(0);
    }
  });

  it('preserves a different task already installed in either index or in the local cache', async () => {
    await seed();
    await redis.set(key, 'new-task'); await redis.set(active, 'new-task');
    const foreign = { ...task(), chatId: 99 };
    f.tasks.set(foreign.id, foreign);
    await runCodeActTask(task());
    expect(await redis.get(key)).toBe('new-task'); expect(await redis.get(active)).toBe('new-task');
    expect(f.tasks.get(foreign.id)).toEqual(foreign);
    expect((await loadCodeActTask('resumed'))?.status).toBe('failed');
  });

  it('CAS refuses a changed durable snapshot without removing indexes or archiving the wrong version', async () => {
    await seed();
    const originalEval = redis.eval.bind(redis);
    const newer = JSON.stringify({ ...task(), pendingUserInput: [{ text: 'new synthetic clarification' }] });
    vi.spyOn(redis, 'eval').mockImplementationOnce(async (...args: Parameters<Redis['eval']>) => {
      await redis.hset('xxb:codeact:tasks', 'resumed', newer);
      return originalEval(...args);
    });
    expect(await retireHeldCheckpointTask(task(), 'checkpoint_missing')).toBeNull();
    expect(await redis.hget('xxb:codeact:tasks', 'resumed')).toBe(newer);
    expect(await redis.get(key)).toBe('resumed');
    expect(await redis.hlen('xxb:codeact:checkpoint-held')).toBe(0);
  });

  it('archive or cleanup storage failure never executes or mutates a task through queue failure cleanup', async () => {
    const raw = await seed();
    await redis.set('xxb:codeact:activation-held', 'wrong-type');
    await expect(runCodeActTask(task())).resolves.toBeUndefined();
    expect(await redis.hget('xxb:codeact:tasks', 'resumed')).toBe(raw);
    expect(await redis.get(key)).toBe('resumed');
    await redis.del('xxb:codeact:activation-held');
    vi.spyOn(redis, 'eval').mockRejectedValueOnce(new Error('synthetic storage outage'));
    await expect(runCodeActTask(task())).resolves.toBeUndefined();
    expect(await redis.hget('xxb:codeact:tasks', 'resumed')).toBe(raw);
    expect(await redis.get(key)).toBe('resumed');
    expect(f.tasks.get('resumed')?.status).toBe('waiting_user');
    expect(f.send).not.toHaveBeenCalled(); expect(f.collect).not.toHaveBeenCalled();
  });

  it('activation-invalid inputs keep the original task and active indexes untouched', async () => {
    const raw = await seed();
    f.config.META_SUBAGENT_ENABLED = false;
    await runCodeActTask(task());
    expect(await redis.hget('xxb:codeact:tasks', 'resumed')).toBe(raw);
    expect(await redis.get(key)).toBe('resumed');
    expect(await redis.hlen('xxb:codeact:checkpoint-held')).toBe(0);
  });
});
