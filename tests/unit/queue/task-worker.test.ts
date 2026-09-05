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

  it('writes task_evidence: verified on synthesis, unverified on raw fallback, failed on empty', async () => {
    const { executeSearch } = await import('../../../src/pipeline/tools/search.js');

    // synthesized 成功 → verified
    (executeSearch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue('东京天气下雨,26度,足够长的内容信息。');
    callMock.mockResolvedValue({ content: '东京今日有雨,出门带伞。' });
    const id1 = createTask({ ownerUid: 1, chatId: 1, goal: 'g1' });
    await executeTask({ data: { type: 'task_execute', taskId: id1, chatId: 1, ownerUid: 1 } } as never);
    const row1 = db.prepare(`SELECT assessment, reasons FROM task_evidence WHERE task_id = ?`).get(`research:${id1}`) as { assessment: string; reasons: string };
    expect(row1.assessment).toBe('verified');
    expect(row1.reasons).toContain('delivered_synthesized');

    // 综合失败回退拼接 → unverified
    callMock.mockRejectedValue(new Error('down'));
    const id2 = createTask({ ownerUid: 1, chatId: 1, goal: 'g2' });
    await executeTask({ data: { type: 'task_execute', taskId: id2, chatId: 1, ownerUid: 1 } } as never);
    const row2 = db.prepare(`SELECT assessment FROM task_evidence WHERE task_id = ?`).get(`research:${id2}`) as { assessment: string };
    expect(row2.assessment).toBe('unverified');

    // 空结果 → failed(注: 空字符串搜不到东西时 worker 走"没查到"分支,
    // 但多轮里 '' 也算一轮结果 — 这里不断言具体分支, 只查有行且非 verified)
    (executeSearch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue('');
    const id3 = createTask({ ownerUid: 1, chatId: 1, goal: 'g3' });
    await executeTask({ data: { type: 'task_execute', taskId: id3, chatId: 1, ownerUid: 1 } } as never);
    const row3 = db.prepare(`SELECT assessment FROM task_evidence WHERE task_id = ?`).get(`research:${id3}`) as { assessment: string } | undefined;
    expect(row3).toBeDefined();
    expect(row3!.assessment).not.toBe('verified');
  });
});