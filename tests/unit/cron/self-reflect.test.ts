import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

let db: Database.Database;
const callWithFallbackMock = vi.fn();
const getRecentMock = vi.fn();
const zrangeMock = vi.fn();

vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => db }));
vi.mock('../../../src/db/redis.js', () => ({
  getRedis: () => ({ zrange: (...args: unknown[]) => zrangeMock(...args) }),
}));
vi.mock('../../../src/ai/fallback.js', () => ({
  callWithFallback: (...args: unknown[]) => callWithFallbackMock(...args),
}));
vi.mock('../../../src/pipeline/context/manager.js', () => ({
  getRecent: (...args: unknown[]) => getRecentMock(...args),
}));
vi.mock('../../../src/shared/config.js', () => ({
  loadCachedPrompt: () => 'self-reflect system prompt',
}));
vi.mock('../../../src/env.js', () => ({
  env: () => ({ SELF_REFLECT_ENABLED: true, SELF_REFLECT_USAGE: 'judge', MASTER_UID: 6251541967 }),
}));

const { parseSelfReflectOutput, runSelfReflect } = await import('../../../src/cron/self-reflect.js');
const { saveSelfNotes, getActiveSelfNotes, pruneSelfNotes } = await import('../../../src/tracking/self-model.js');

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE self_model_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      note TEXT NOT NULL, evidence TEXT, created_at INTEGER NOT NULL
    );
  `);
  callWithFallbackMock.mockReset();
  getRecentMock.mockReset().mockResolvedValue([
    { role: 'user', uid: 6251541967, textContent: '帮我看下这个报错', timestamp: 1, messageId: 1 },
    { role: 'assistant', uid: 0, textContent: '好嘞主人～让本喵看看喵～', timestamp: 2, messageId: 2 },
    { role: 'user', uid: 6251541967, textContent: '...直接说原因', timestamp: 3, messageId: 3 },
  ]);
  zrangeMock.mockReset().mockResolvedValue(['-1001234567890']);
});

describe('self-model storage', () => {
  it('saves notes and retrieves newest first with limit', () => {
    saveSelfNotes([
      { note: '技术问题直接给答案', evidence: '主人说「直接说原因」' },
      { note: '深夜回复要短' },
    ]);
    const notes = getActiveSelfNotes(5);
    expect(notes.length).toBe(2);
    expect(notes[0]!.note).toBe('深夜回复要短');
    expect(notes[0]!.evidence).toBeNull();
    expect(notes[1]!.evidence).toContain('直接说原因');
  });

  it('skips blank notes', () => {
    expect(saveSelfNotes([{ note: '  ' }, { note: 'real note content' }])).toBe(1);
  });

  it('prunes to keep most recent N', () => {
    for (let i = 0; i < 25; i++) saveSelfNotes([{ note: `note number ${i}` }]);
    pruneSelfNotes(20);
    const notes = getActiveSelfNotes(100);
    expect(notes.length).toBe(20);
    expect(notes[0]!.note).toBe('note number 24');
  });
});

describe('parseSelfReflectOutput', () => {
  it('parses clean and fenced JSON', () => {
    const raw = '```json\n{"notes":[{"note":"深夜别太热情","evidence":"昨晚连发5条"}]}\n```';
    const r = parseSelfReflectOutput(raw)!;
    expect(r.length).toBe(1);
    expect(r[0]!.note).toBe('深夜别太热情');
  });

  it('returns null on garbage; caps at 5 and drops blanks', () => {
    expect(parseSelfReflectOutput('嗯我觉得')).toBeNull();
    expect(parseSelfReflectOutput('{"other": 1}')).toBeNull();
    const many = JSON.stringify({
      notes: Array.from({ length: 7 }, (_, i) => ({ note: `adjustment ${i}`, evidence: '' })),
    });
    expect(parseSelfReflectOutput(many)!.length).toBe(5);
  });
});

describe('runSelfReflect', () => {
  it('full flow: samples → LLM → notes saved', async () => {
    callWithFallbackMock.mockResolvedValue({
      content: JSON.stringify({
        notes: [{ note: '技术问题直接给原因别卖萌', evidence: '主人说「...直接说原因」' }],
      }),
    });
    await runSelfReflect();
    expect(callWithFallbackMock).toHaveBeenCalledOnce();
    const arg = callWithFallbackMock.mock.calls[0]![0] as { usage: string };
    expect(arg.usage).toBe('judge');
    const notes = getActiveSelfNotes(5);
    expect(notes.length).toBe(1);
    expect(notes[0]!.note).toContain('直接给原因');
  });

  it('skips silently on unparseable output and LLM failure', async () => {
    callWithFallbackMock.mockResolvedValue({ content: '今天天气不错' });
    await runSelfReflect();
    expect(getActiveSelfNotes(5).length).toBe(0);

    callWithFallbackMock.mockRejectedValue(new Error('providers down'));
    await expect(runSelfReflect()).resolves.toBeUndefined();
  });

  it('empty notes array saves nothing (model says nothing to adjust)', async () => {
    callWithFallbackMock.mockResolvedValue({ content: '{"notes": []}' });
    await runSelfReflect();
    expect(getActiveSelfNotes(5).length).toBe(0);
  });

  it('skips when no samples available', async () => {
    getRecentMock.mockResolvedValue([]);
    zrangeMock.mockResolvedValue([]);
    await runSelfReflect();
    expect(callWithFallbackMock).not.toHaveBeenCalled();
  });
});
