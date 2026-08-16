import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

let db: Database.Database;
const callMock = vi.fn();
const sendMock = vi.fn();
const envMock = vi.fn();

vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => db }));
vi.mock('../../../src/env.js', () => ({ env: () => envMock() }));
vi.mock('../../../src/db/redis.js', () => ({
  getRedis: () => ({ get: vi.fn(), set: vi.fn(), del: vi.fn() }),
}));
vi.mock('../../../src/ai/fallback.js', () => ({ callWithFallback: (...a: unknown[]) => callMock(...a) }));
vi.mock('../../../src/pipeline/tools/search.js', () => ({ executeSearch: vi.fn() }));
vi.mock('../../../src/bot/sender/telegram.js', () => ({
  sendMessage: (...a: unknown[]) => sendMock(...a),
}));

const { executeTask } = await import('../../../src/queue/task-worker.js');
const { createTask } = await import('../../../src/agent/task-store.js');

async function loadMigrations() {
  const fs = await import('node:fs');
  for (const f of fs.readdirSync('migrations').sort()) {
    if (!f.endsWith('.sql')) continue;
    db.exec(fs.readFileSync(`migrations/${f}`, 'utf8'));
  }
}

beforeEach(async () => {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  await loadMigrations();
  envMock.mockReturnValue({ TASK_EXECUTOR_ENABLED: true });
  callMock.mockReset();
  sendMock.mockReset();
});

function fakeJob(taskId: number) {
  return { data: { type: 'task_execute', taskId, chatId: 6251541967, ownerUid: 6251541967 } } as never;
}

describe('task-worker synthesis', () => {
  it('uses LLM synthesis when search succeeds and summarize returns text', async () => {
    const { executeSearch } = await import('../../../src/pipeline/tools/search.js');
    (executeSearch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue('东京天气下雨,26度。');
    callMock.mockResolvedValue({ content: '东京今日有雨,22-28度,出门带伞。' });

    const id = createTask({ ownerUid: 6251541967, chatId: 6251541967, goal: '东京今日天气' });
    const out = await executeTask(fakeJob(id));

    expect(callMock).toHaveBeenCalledTimes(1);
    expect((callMock.mock.calls[0]![0] as { usage: string }).usage).toBe('summarize');
    expect(sendMock).toHaveBeenCalledWith(6251541967, expect.stringContaining('东京今日有雨'));
    expect(out).toBe('东京今日有雨,22-28度,出门带伞。');
  });

  it('falls back to raw join when synthesis fails (LLM error)', async () => {
    const { executeSearch } = await import('../../../src/pipeline/tools/search.js');
    (executeSearch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue('第一轮搜索内容,足够长的一些信息内容。');
    callMock.mockRejectedValue(new Error('provider down'));

    const id = createTask({ ownerUid: 6251541967, chatId: 6251541967, goal: '测试目标' });
    const out = await executeTask(fakeJob(id));

    expect(sendMock).toHaveBeenCalledWith(6251541967, expect.stringContaining('第一轮搜索内容'));
    expect(out).toContain('第一轮搜索内容');
  });

  it('falls back when synthesis returns empty content', async () => {
    const { executeSearch } = await import('../../../src/pipeline/tools/search.js');
    (executeSearch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue('第二轮的搜索内容,也足够长可以发送给用户看。');
    callMock.mockResolvedValue({ content: ' ' });

    const id = createTask({ ownerUid: 6251541967, chatId: 6251541967, goal: '另一个目标' });
    const out = await executeTask(fakeJob(id));

    expect(out).toContain('第二轮的搜索内容');
  });
});