import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: Database.Database;
const { config, queued, search, send, members } = vi.hoisted(() => ({
  config: { TASK_EXECUTOR_ENABLED: true, TASK_MAX_ROUNDS: 1, PROACTIVE_ACTIVATED_AT_SEC: 1000 },
  queued: vi.fn(), search: vi.fn(), send: vi.fn(), members: vi.fn(),
}));
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => db }));
vi.mock('../../../src/env.js', () => ({ env: () => config }));
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => ({}) }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../../../src/pipeline/tools/search.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/pipeline/tools/search.js')>(),
  executeSearchDetailed: search,
}));
vi.mock('../../../src/ai/fallback.js', () => ({ callWithFallback: vi.fn(async () => ({ content: '已验证的新任务研究结果，可用于这次测试。' })) }));
vi.mock('../../../src/bot/sender/telegram.js', () => ({ sendMessage: send }));
vi.mock('../../../src/agent/task-evidence-store.js', () => ({ saveTaskEvidence: vi.fn() }));
vi.mock('../../../src/pipeline/context/manager.js', () => ({ getGroupMembers: members }));
vi.mock('bullmq', () => ({ Queue: class { add = queued; }, Worker: class {} }));

import { createTask, getTask, listActiveTasks, scheduleWake } from '../../../src/agent/task-store.js';
import { wakeDueTasks } from '../../../src/cron/task-wake.js';
import { executeTask } from '../../../src/queue/task-worker.js';

function makeTask(createdAt: number, chatId = -100): number {
  const id = createTask({ ownerUid: 42, chatId, goal: 'test research', maxRounds: 1 });
  db.prepare('UPDATE tasks SET created_at = ?, updated_at = ? WHERE id = ?').run(createdAt, createdAt, id);
  return id;
}
function job(taskId: number, chatId = -100) {
  return { data: { type: 'task_execute', taskId, chatId, ownerUid: 42 } } as never;
}

describe('restored task activation boundaries', () => {
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(readFileSync(join(__dirname, '../../../migrations/0065_tasks.sql'), 'utf8'));
    vi.clearAllMocks(); config.PROACTIVE_ACTIVATED_AT_SEC = 1000;
    members.mockResolvedValue([{ uid: 42, lastSeen: 1100 }]);
    search.mockResolvedValue({ status: 'ok', provider: 'DDG-Lite',
      results: [{ title: '来源', snippet: '可用于综合的一轮新搜索结果。', url: 'https://example.org/source' }],
      attempts: [{ provider: 'DDG-Lite', status: 'success' }] });
    queued.mockResolvedValue({ id: 'test-job' });
    send.mockResolvedValue(1);
  });
  afterEach(() => db.close());

  it('keeps old task history and states intact while hiding it from the active list', () => {
    const old = makeTask(999), boundary = makeTask(1000), fresh = makeTask(1001);
    expect(listActiveTasks(42, -100).map((task) => task.id)).toEqual([fresh]);
    expect(getTask(old)?.state).toBe('pending');
    expect(getTask(boundary)?.state).toBe('pending');
    config.PROACTIVE_ACTIVATED_AT_SEC = 0;
    expect(listActiveTasks(42, -100).map((task) => task.id)).toEqual([fresh, boundary, old]);
  });

  it('applies activation before the active-task result limit so updated old tasks cannot hide a new task', () => {
    const fresh = makeTask(1001);
    for (let index = 0; index < 21; index++) {
      const old = makeTask(900 + index);
      db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(2000 + index, old);
    }
    expect(listActiveTasks(42, -100).map((task) => task.id)).toEqual([fresh]);
  });

  it('wakes only tasks created after activation in newly active destinations', async () => {
    const old = makeTask(999), boundary = makeTask(1000), fresh = makeTask(1001), inactive = makeTask(1002, -200);
    for (const id of [old, boundary, fresh, inactive]) scheduleWake(id, 900);
    members.mockImplementation(async (chatId: number) => [{ uid: 42, lastSeen: chatId === -100 ? 1100 : 900 }]);
    expect(await wakeDueTasks()).toBe(1);
    expect(queued).toHaveBeenCalledWith('task_execute', expect.objectContaining({ taskId: fresh, chatId: -100 }));
    expect(getTask(old)?.state).toBe('pending');
  });

  it.each([999, 1000])('never executes an old task created at %s even if it is already in BullMQ', async (createdAt) => {
    const id = makeTask(createdAt);
    expect(await executeTask(job(id))).toBeNull();
    expect(search).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
    expect(getTask(id)?.state).toBe('pending');
    expect(getTask(id)?.search_round).toBe(0);
  });

  it('does not execute a new task until its destination has new human activity', async () => {
    const id = makeTask(1001);
    members.mockResolvedValue([{ uid: 42, lastSeen: 1000 }]);
    expect(await executeTask(job(id))).toBeNull();
    expect(search).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
    expect(getTask(id)?.state).toBe('pending');
  });

  it('executes a newly created task after new human activity', async () => {
    const id = makeTask(1001);
    expect(await executeTask(job(id))).toContain('已验证的新任务');
    expect(search).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(-100, expect.stringContaining('已验证的新任务'));
    expect(getTask(id)?.state).toBe('done');
  });
});
