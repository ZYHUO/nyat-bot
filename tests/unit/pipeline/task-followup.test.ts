import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: Database.Database;

vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => db }));
vi.mock('../../../src/env.js', () => ({ env: () => ({ TASK_EXECUTOR_ENABLED: true }) }));
vi.mock('../../../src/bot/sender/telegram.js', () => ({ sendMessage: vi.fn(async () => ({})) }));
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => ({}) }));
vi.mock('bullmq', () => ({ Queue: class { async add() { return {}; } } }));

const taskTrigger = await import('../../../src/pipeline/judge/task-trigger.js');
const { createTask, listActiveTasks } = await import('../../../src/agent/task-store.js');

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(readFileSync(join(__dirname, '../../../migrations/0065_tasks.sql'), 'utf8'));
  vi.clearAllMocks();
});

describe('task follow-up link (L0, deterministic)', () => {
  it('classifies a cancel request against the active task', () => {
    createTask({ ownerUid: 42, chatId: -100, goal: '查猫粮测评' });
    const r = taskTrigger.classifyTaskFollowUp('算了别查了', listActiveTasks(42, -100));
    expect(r?.action).toBe('cancel');
  });

  it('classifies a progress nudge against the active task', () => {
    createTask({ ownerUid: 42, chatId: -100, goal: '查猫粮测评' });
    const r = taskTrigger.classifyTaskFollowUp('查得怎么样了', listActiveTasks(42, -100));
    expect(r?.action).toBe('progress');
  });

  it('classifies a supplement mentioning the goal', () => {
    createTask({ ownerUid: 42, chatId: -100, goal: '查猫粮测评' });
    const r = taskTrigger.classifyTaskFollowUp('顺便看看猫罐头', listActiveTasks(42, -100));
    expect(r?.action).toBe('supplement');
  });

  it('returns null when there is no active task', () => {
    expect(taskTrigger.classifyTaskFollowUp('算了', [])).toBeNull();
  });

  it('returns null for plain chatter unrelated to the task', () => {
    createTask({ ownerUid: 42, chatId: -100, goal: '查猫粮测评' });
    expect(taskTrigger.classifyTaskFollowUp('今天天气真好', listActiveTasks(42, -100))).toBeNull();
  });

  it('handleTaskFollowUp cancels and confirms', async () => {
    const { sendMessage } = await import('../../../src/bot/sender/telegram.js');
    createTask({ ownerUid: 42, chatId: -100, goal: '查猫粮测评' });
    const taken = await taskTrigger.handleTaskFollowUp(-100, 42, '算了别查了', true);
    expect(taken).toBe(true);
    expect(listActiveTasks(42, -100)).toHaveLength(0);
    expect((sendMessage as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce();
  });

  it('handleTaskFollowUp does nothing without mention or active task', async () => {
    expect(await taskTrigger.handleTaskFollowUp(-100, 42, '算了', false)).toBe(false);
    expect(await taskTrigger.handleTaskFollowUp(-100, 99, '算了别查了', true)).toBe(false);
  });
});
