import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: Database.Database;
const adds: unknown[] = [];

vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => db }));
vi.mock('../../../src/db/redis.js', () => ({ getRedis: vi.fn(() => ({})) }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('bullmq', () => {
  class Queue {
    constructor(name: string, opts: unknown) {}
    async add(name: string, data: unknown) { adds.push(data); return { id: 'wake-job' }; }
  }
  return { Queue };
});

const { wakeDueTasks } = await import('../../../src/cron/task-wake.js');
const { createTask, scheduleWake, completeTask } = await import('../../../src/agent/task-store.js');

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(readFileSync(join(__dirname, '../../../migrations/0065_tasks.sql'), 'utf8'));
  adds.length = 0;
});

describe('wakeDueTasks', () => {
  it('dispatches due tasks', async () => {
    const now = Math.floor(Date.now() / 1000);
    const id = createTask({ ownerUid: 42, chatId: -100, goal: 'g' });
    scheduleWake(id, now - 5, '定时检查');
    const n = await wakeDueTasks();
    expect(n).toBe(1);
    expect(adds).toHaveLength(1);
    expect((adds[0] as { taskId: number }).taskId).toBe(id);
  });

  it('skips not-yet-due tasks', async () => {
    const now = Math.floor(Date.now() / 1000);
    const id = createTask({ ownerUid: 42, chatId: -100, goal: 'g' });
    scheduleWake(id, now + 999);
    const n = await wakeDueTasks();
    expect(n).toBe(0);
    expect(adds).toHaveLength(0);
  });

  it('skips completed tasks (race guard)', async () => {
    const now = Math.floor(Date.now() / 1000);
    const id = createTask({ ownerUid: 42, chatId: -100, goal: 'g' });
    scheduleWake(id, now - 5);
    completeTask(id, 'done');
    const n = await wakeDueTasks();
    expect(n).toBe(0);
  });
});
