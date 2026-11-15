import { afterEach, describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
let db: Database.Database;
const queued = new Map<string, unknown>();
const { addMock } = vi.hoisted(() => ({ addMock: vi.fn() }));
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => db }));
vi.mock('../../../src/db/redis.js', () => ({ getRedis: vi.fn(() => ({})) }));
vi.mock('../../../src/env.js', () => ({ env: () => ({ TASK_EXECUTOR_ENABLED: true, TASK_MAX_ROUNDS: 6, BOT_TOKEN: '123:synthetic-test', COGNITIVE_EVENTS_ENABLED: false }) }));
vi.mock('../../../src/cron/activation-policy.js', () => ({ checkProactiveActivation: vi.fn(async () => ({ allowed: true })) }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('bullmq', () => ({ Queue: class { add = addMock; }, Worker: class {} }));
const { wakeDueTasks } = await import('../../../src/cron/task-wake.js');
const { createTask, getTask, scheduleWake, completeTask, cancelTask } = await import('../../../src/agent/task-store.js');
beforeEach(() => {
  db = new Database(':memory:');
  for (const file of readdirSync('migrations').sort()) if (file.endsWith('.sql')) db.exec(readFileSync('migrations/' + file, 'utf8'));
  queued.clear(); addMock.mockReset();
  addMock.mockImplementation(async (_name, data, options) => { queued.set(options.jobId, data); return { id: options.jobId }; });
});
afterEach(() => db.close());
describe('durable wake generation', () => {
  it('uses the same deterministic job for duplicate ticks and a new one after reschedule', async () => {
    const now = Math.floor(Date.now() / 1000);
    const id = createTask({ ownerUid: 42, chatId: -100, goal: 'g' });
    scheduleWake(id, now - 5, 'due');
    await Promise.all([wakeDueTasks(), wakeDueTasks()]);
    expect(queued.size).toBe(1);
    expect([...queued.values()][0]).toMatchObject({ taskId: id, wakeGeneration: getTask(id)!.wake_generation });
    scheduleWake(id, now - 1, 'new wake');
    await wakeDueTasks();
    expect(queued.size).toBe(2);
  });
  it('recovers the durable initial task when enqueue never happened', async () => {
    const id = createTask({ ownerUid: 42, chatId: -100, goal: 'initial enqueue crash' });
    await wakeDueTasks();
    expect([...queued.values()][0]).toMatchObject({ taskId: id, wakeGeneration: 0 });
  });
  it('skips future, completed and cancelled tasks', async () => {
    const now = Math.floor(Date.now() / 1000);
    const a = createTask({ ownerUid: 42, chatId: -100, goal: 'future' });
    const b = createTask({ ownerUid: 42, chatId: -100, goal: 'done' });
    const c = createTask({ ownerUid: 42, chatId: -100, goal: 'cancelled' });
    scheduleWake(a, now + 999); completeTask(b, 'done'); cancelTask(c);
    expect(await wakeDueTasks()).toBe(0);
    expect(queued.size).toBe(0);
  });
  it('retains a due task when enqueue fails, using the same generation on retry', async () => {
    const id = createTask({ ownerUid: 42, chatId: -100, goal: 'queue outage' });
    addMock.mockRejectedValueOnce(new Error('queue unavailable'));
    await expect(wakeDueTasks()).rejects.toThrow('queue unavailable');
    expect(getTask(id)?.next_wake).not.toBeNull();
    await wakeDueTasks();
    expect(queued.size).toBe(1);
    expect(addMock.mock.calls[0]?.[2].jobId).toBe(addMock.mock.calls[1]?.[2].jobId);
  });
});
