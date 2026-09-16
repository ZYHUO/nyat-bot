import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

let testDb: Database.Database;

// 可变 env mock —— 每个测试可单独翻转 flag。
const mockEnv = {
  DREAMING_ENABLED: true,
  MASTER_UID: 7624515600,
  RELATIONSHIP_QUANT_ENABLED: false,
};

vi.mock('../../../src/env.js', () => ({
  env: () => mockEnv,
}));

vi.mock('../../../src/db/sqlite.js', () => ({
  getDb: () => testDb,
}));

vi.mock('../../../src/shared/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// 手mock Redis:任务 hash / digest list / 活跃群 zset 各自可调。
const redisMock = {
  hgetall: vi.fn(async () => ({}) as Record<string, string>),
  lrange: vi.fn(async () => [] as string[]),
  zrange: vi.fn(async () => [] as string[]),
};
vi.mock('../../../src/db/redis.js', () => ({
  getRedis: () => redisMock,
}));

const enqueueCodeActJob = vi.fn(async () => {});
vi.mock('../../../src/subagent/queue.js', () => ({
  enqueueCodeActJob,
}));

// 进程内任务表(与 redis hash 并集去重) —— 默认空。
const globalTasks: { listTasks: () => unknown[] } = { listTasks: () => [] };
vi.mock('../../../src/meta/global-state.js', () => ({
  getGlobalState: () => globalTasks,
}));

// prompt loader —— 默认返回可辨识内容,可清空测兜底常量。
const promptState = { content: 'DREAMING_PROMPT_FROM_MD' };
vi.mock('../../../src/shared/config.js', () => ({
  loadCachedPrompt: vi.fn(() => promptState.content),
}));

const { runDreaming, buildDreamingContext, DREAMING_MAX_CONTEXT_CHARS, DREAMING_STALE_SEC } =
  await import('../../../src/cron/dreaming.js');

function initSchema(db: Database.Database): void {
  const migrations = [
    'migrations/0005_user_profiles.sql',
    'migrations/0018_self_history_relationship.sql',
    'migrations/0068_dreaming.sql',
    'migrations/0069_relationship_quant.sql',
  ];
  for (const m of migrations) {
    db.exec(readFileSync(resolve(process.cwd(), m), 'utf-8'));
  }
}

interface RunRow {
  id: number;
  started_at: number;
  ended_at: number | null;
  status: string;
  tasks_reviewed: number;
  summary: string | null;
}

function runs(): RunRow[] {
  return testDb.prepare(`SELECT * FROM dreaming_runs ORDER BY id`).all() as RunRow[];
}

function seedPerson(chatId: number, uid: number, name: string, affinity: number): void {
  testDb
    .prepare(
      `INSERT INTO chat_relationships (chat_id, uid, affinity, interaction_count, last_interaction_at, last_summary, updated_at)
       VALUES (?, ?, ?, 10, 1700000000, '', 1700000000)`,
    )
    .run(chatId, uid, affinity);
  testDb
    .prepare(
      `INSERT INTO user_profiles (chat_id, uid, username, full_name) VALUES (?, ?, '', ?)`,
    )
    .run(chatId, uid, name);
}

function taskJson(id: string, createdAt: number, over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id,
    chatId: -100123,
    contentDirection: '看看大家在聊什么',
    createdAt,
    status: 'done',
    resultSummary: '聊完了',
    ...over,
  });
}

const NOW_SEC = Math.floor(Date.now() / 1000);

beforeEach(() => {
  testDb = new Database(':memory:');
  initSchema(testDb);
  mockEnv.DREAMING_ENABLED = true;
  mockEnv.MASTER_UID = 7624515600;
  mockEnv.RELATIONSHIP_QUANT_ENABLED = false;
  redisMock.hgetall.mockResolvedValue({});
  redisMock.lrange.mockResolvedValue([]);
  redisMock.zrange.mockResolvedValue([]);
  globalTasks.listTasks = () => [];
  promptState.content = 'DREAMING_PROMPT_FROM_MD';
  enqueueCodeActJob.mockClear();
});

afterEach(() => {
  testDb.close();
});

describe('runDreaming guards', () => {
  it('flag off → skipped, no run row, no dispatch', async () => {
    mockEnv.DREAMING_ENABLED = false;
    const r = await runDreaming();
    expect(r).toMatchObject({ status: 'skipped', reason: 'disabled' });
    expect(runs()).toEqual([]);
    expect(enqueueCodeActJob).not.toHaveBeenCalled();
  });

  it('live running row → skipped, no new row, no dispatch', async () => {
    testDb
      .prepare(`INSERT INTO dreaming_runs (started_at, status) VALUES (?, 'running')`)
      .run(NOW_SEC - 600);
    const r = await runDreaming();
    expect(r).toMatchObject({ status: 'skipped', reason: 'already_running' });
    expect(runs()).toHaveLength(1);
    expect(enqueueCodeActJob).not.toHaveBeenCalled();
  });

  it('stale running row (>2h) counts as dead → marked failed, new run proceeds', async () => {
    testDb
      .prepare(`INSERT INTO dreaming_runs (started_at, status) VALUES (?, 'running')`)
      .run(NOW_SEC - DREAMING_STALE_SEC - 10);
    const r = await runDreaming();
    expect(r.status).toBe('done');
    const all = runs();
    expect(all).toHaveLength(2);
    expect(all[0]).toMatchObject({ status: 'failed', summary: 'stale_timeout' });
    expect(all[1]).toMatchObject({ status: 'done' });
    expect(enqueueCodeActJob).toHaveBeenCalledTimes(1);
  });

  it('MASTER_UID unset → run marked failed', async () => {
    mockEnv.MASTER_UID = 0;
    const r = await runDreaming();
    expect(r).toMatchObject({ status: 'failed', reason: 'no_master_uid' });
    expect(runs()[0]).toMatchObject({ status: 'failed', summary: 'no_master_uid' });
    expect(enqueueCodeActJob).not.toHaveBeenCalled();
  });
});

describe('runDreaming dispatch', () => {
  it('dispatches one CodeAct task to master DM with [dreaming] marker + inline prompt', async () => {
    const r = await runDreaming();
    expect(r.status).toBe('done');
    expect(enqueueCodeActJob).toHaveBeenCalledTimes(1);
    const task = enqueueCodeActJob.mock.calls[0]![0] as {
      id: string;
      chatId: number;
      contentDirection: string;
      status: string;
      messageThreadId?: number;
    };
    expect(task.chatId).toBe(mockEnv.MASTER_UID);
    expect(task.chatId).toBeGreaterThan(0); // DM, not group
    expect(task.id).toMatch(/^dreaming_/);
    expect(task.contentDirection.startsWith('[dreaming]')).toBe(true);
    expect(task.contentDirection).toContain('DREAMING_PROMPT_FROM_MD');
    expect(task.contentDirection).not.toContain('[selfplay]'); // 不能触发自玩路径
    expect(task.messageThreadId).toBeUndefined();
    expect(task.status).toBe('queued');
  });

  it('run row lifecycle: running → done with dispatched note + ended_at', async () => {
    const r = await runDreaming();
    const row = runs()[0]!;
    expect(r.runId).toBe(row.id);
    expect(row.status).toBe('done');
    expect(row.ended_at).not.toBeNull();
    expect(row.ended_at!).toBeGreaterThanOrEqual(row.started_at);
    expect(row.summary).toBe(`dispatched: ${r.taskId}`);
  });

  it('falls back to embedded prompt when prompt file loads empty', async () => {
    promptState.content = '';
    const r = await runDreaming();
    expect(r.status).toBe('done');
    const task = enqueueCodeActJob.mock.calls[0]![0] as { contentDirection: string };
    expect(task.contentDirection).toContain('做梦时间'); // 兜底常量内容
    expect(task.contentDirection).not.toContain('DREAMING_PROMPT_FROM_MD');
  });

  it('enqueue failure → run marked failed with error summary', async () => {
    enqueueCodeActJob.mockRejectedValueOnce(new Error('boom-redis-down'));
    const r = await runDreaming();
    expect(r).toMatchObject({ status: 'failed', reason: 'dispatch_failed' });
    const row = runs()[0]!;
    expect(row.status).toBe('failed');
    expect(row.summary).toContain('boom-redis-down');
    expect(row.ended_at).not.toBeNull();
  });
});

describe('buildDreamingContext', () => {
  it('collects tasks since given ts from redis hash + global state, deduped', async () => {
    const since = NOW_SEC - 3600;
    redisMock.hgetall.mockResolvedValue({
      old: taskJson('old', (since - 100) * 1000), // 窗口外
      a: taskJson('a', (since + 10) * 1000),
      b: taskJson('b', (since + 20) * 1000),
    });
    globalTasks.listTasks = () => [
      // 同 id 覆盖 redis 行(进程内状态更新),新增一条 c。
      { id: 'b', chatId: -100123, contentDirection: '看看大家在聊什么', createdAt: (since + 20) * 1000, status: 'done', resultSummary: '进程内终态' },
      { id: 'c', chatId: 7624515600, contentDirection: '帮主人查资料', createdAt: (since + 30) * 1000, status: 'running' },
    ];
    const ctx = await buildDreamingContext(since);
    expect(ctx.tasksReviewed).toBe(3);
    expect(ctx.text).toContain('做梦素材');
    expect(ctx.text).not.toContain('old');
    expect(ctx.text).toContain('进程内终态'); // 进程内覆盖了 redis 版本
    expect(ctx.text.indexOf('看看大家在聊什么')).toBeLessThan(ctx.text.indexOf('帮主人查资料')); // 时间升序
  });

  it('includes top-affinity people (affinity path) with display names', async () => {
    seedPerson(-100123, 11, '小明', 88);
    seedPerson(-100123, 22, '小红', 95);
    seedPerson(-100456, 33, '阿伟', 40);
    const ctx = await buildDreamingContext(NOW_SEC - 3600);
    expect(ctx.text).toContain('小红');
    expect(ctx.text).toContain('小明');
    expect(ctx.text.indexOf('小红')).toBeLessThan(ctx.text.indexOf('小明')); // 按好感降序
    expect(ctx.text).toContain('群-100123');
  });

  it('uses quant score/tier when RELATIONSHIP_QUANT_ENABLED', async () => {
    mockEnv.RELATIONSHIP_QUANT_ENABLED = true;
    seedPerson(-100123, 11, '小明', 10);
    testDb
      .prepare(`UPDATE chat_relationships SET quant_score = 91, quant_tier = 1 WHERE uid = 11`)
      .run();
    const ctx = await buildDreamingContext(NOW_SEC - 3600);
    expect(ctx.text).toContain('Tier1');
    expect(ctx.text).toContain('分 91');
  });

  it('includes session digests and active groups', async () => {
    redisMock.lrange.mockResolvedValue([
      JSON.stringify({ at: NOW_SEC * 1000, text: '给群 -100123 派发了 L0 回复' }),
      'not-json',
    ]);
    redisMock.zrange.mockResolvedValue(['-100123', '-100456', '12345']);
    const ctx = await buildDreamingContext(NOW_SEC - 3600);
    expect(ctx.text).toContain('派发了 L0 回复');
    expect(ctx.text).not.toContain('not-json');
    expect(ctx.text).toContain('-100123, -100456'); // 只留群(负数)
    expect(ctx.text).not.toContain('12345');
  });

  it('caps total size: oldest digests dropped first, then oldest tasks, then hard slice', async () => {
    const since = NOW_SEC - 86400;
    const hash: Record<string, string> = {};
    for (let i = 0; i < 200; i++) {
      hash[`t${i}`] = taskJson(`t${i}`, (since + i) * 1000, {
        contentDirection: `任务${i} ${'长'.repeat(80)}`,
        resultSummary: '果'.repeat(80),
      });
    }
    redisMock.hgetall.mockResolvedValue(hash);
    redisMock.lrange.mockResolvedValue(
      Array.from({ length: 30 }, (_, i) =>
        JSON.stringify({ at: (since + i) * 1000, text: `digest${i} ${'流'.repeat(200)}` }),
      ),
    );
    const ctx = await buildDreamingContext(since);
    expect(ctx.text.length).toBeLessThanOrEqual(DREAMING_MAX_CONTEXT_CHARS);
    expect(ctx.tasksReviewed).toBe(200);
    // 任务超过 40 上限 → 只保留最新 40 条
    expect(ctx.text).toContain('仅列最新');
    expect(ctx.text).not.toContain('任务0 ');
    expect(ctx.text).toContain('任务199');
  });

  it('all sources failing → still returns a valid skeleton', async () => {
    redisMock.hgetall.mockRejectedValue(new Error('redis down'));
    redisMock.lrange.mockRejectedValue(new Error('redis down'));
    redisMock.zrange.mockRejectedValue(new Error('redis down'));
    const ctx = await buildDreamingContext(NOW_SEC - 3600);
    expect(ctx.tasksReviewed).toBe(0);
    expect(ctx.text).toContain('做梦素材');
    expect(ctx.text).toContain('(本周期没有派发过任务)');
    expect(ctx.text).toContain('(无)');
  });
});
