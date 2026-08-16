import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: Database.Database;

vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => db }));
vi.mock('../../../src/env.js', () => ({ env: () => ({ TASK_EXECUTOR_ENABLED: true }) }));

const {
  createTask, getTask, listActiveTasks, listDueTasks, setTaskState,
  appendLedger, setProgress, bumpSearchRound, completeTask, scheduleWake,
  cancelTask, hasActiveTask,
} = await import('../../../src/agent/task-store.js');

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(readFileSync(join(__dirname, '../../../migrations/0065_tasks.sql'), 'utf8'));
});

describe('task-store', () => {
  it('create → get roundtrip with defaults', () => {
    const id = createTask({ ownerUid: 42, chatId: -100, goal: '帮我查 X' });
    const t = getTask(id);
    expect(t).not.toBeNull();
    expect(t!.state).toBe('pending');
    expect(t!.kind).toBe('research');
    expect(t!.ledger).toBe('[]');
    expect(t!.search_round).toBe(0);
    expect(t!.max_rounds).toBe(6);
  });

  it('listActiveTasks returns only active states', () => {
    const a = createTask({ ownerUid: 42, chatId: -100, goal: 'g1' });
    const b = createTask({ ownerUid: 42, chatId: -100, goal: 'g2' });
    completeTask(a, 'done result');
    const active = listActiveTasks(42, -100);
    expect(active.map((t) => t.id)).toEqual([b]);
  });

  it('ledger append keeps JSON shape and caps at 40', () => {
    const id = createTask({ ownerUid: 42, chatId: -100, goal: 'g' });
    for (let i = 0; i < 45; i++) appendLedger(id, { step: `s${i}`, result: `r${i}`, ts: i });
    const t = getTask(id)!;
    const arr = JSON.parse(t.ledger) as { step: string }[];
    expect(arr.length).toBe(40);
    expect(arr[0].step).toBe('s5');
  });

  it('bumpSearchRound reaches max and flags done', () => {
    const id = createTask({ ownerUid: 42, chatId: -100, goal: 'g', maxRounds: 3 });
    expect(bumpSearchRound(id)).toEqual({ round: 1, done: false });
    expect(bumpSearchRound(id)).toEqual({ round: 2, done: false });
    expect(bumpSearchRound(id)).toEqual({ round: 3, done: true });
  });

  it('scheduleWake → listDueTasks picks up due tasks only', () => {
    const now = Math.floor(Date.now() / 1000);
    const id = createTask({ ownerUid: 42, chatId: -100, goal: 'g' });
    scheduleWake(id, now + 100, '定时检查');
    expect(listDueTasks(now + 50)).toHaveLength(0);
    expect(listDueTasks(now + 101)).toHaveLength(1);
  });

  it('completeTask clears wake and sets result', () => {
    const id = createTask({ ownerUid: 42, chatId: -100, goal: 'g' });
    scheduleWake(id, Math.floor(Date.now() / 1000) + 10);
    completeTask(id, '最终结果');
    const t = getTask(id)!;
    expect(t.state).toBe('done');
    expect(t.result).toBe('最终结果');
    expect(t.next_wake).toBeNull();
  });

  it('cancelTask marks cancelled and excluded from active', () => {
    const id = createTask({ ownerUid: 42, chatId: -100, goal: 'g' });
    cancelTask(id);
    expect(getTask(id)!.state).toBe('cancelled');
    expect(listActiveTasks(42, -100)).toHaveLength(0);
    expect(hasActiveTask(42, -100)).toBe(false);
  });

  it('setProgress replaces progress list', () => {
    const id = createTask({ ownerUid: 42, chatId: -100, goal: 'g' });
    setProgress(id, ['还差搜索', '卡在 API']);
    expect(JSON.parse(getTask(id)!.progress)).toEqual(['还差搜索', '卡在 API']);
  });
});
