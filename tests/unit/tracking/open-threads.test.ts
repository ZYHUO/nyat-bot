import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Open threads: what the bot said it would come back to, across a day.
// scratchpad is Redis with a 30-minute TTL — right for "等下我发你文件", useless
// for "明天告诉你". The narrowness is the design: only EXPLICIT commitments are
// recorded, because a general "remember our conversations" store produces the
// uncanny recall that makes a bot feel like a bot.

let db: Database.Database;

vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => db }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
const envValues: Record<string, unknown> = { OPEN_THREADS_ENABLED: true };
vi.mock('../../../src/env.js', () => ({ env: () => envValues }));

const NOW = Math.floor(Date.now() / 1000);

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(readFileSync('migrations/0113_open_threads.sql', 'utf8'));
  envValues['OPEN_THREADS_ENABLED'] = true;
});

const load = async () => {
  vi.resetModules();
  return await import('../../../src/tracking/open-threads.js');
};

describe('open threads', () => {
  it('records a commitment and finds it later', async () => {
    const m = await load();
    const id = m.rememberThread({ chatId: -100, note: '明天帮你查那个显卡', kind: 'promised' });
    expect(id).toBeTruthy();
    // Backdate it so it is past the "still working memory" window.
    db.prepare('UPDATE open_threads SET created_at = ? WHERE id = ?').run(NOW - 90000, id);
    const threads = m.listRaiseableThreads(-100, NOW);
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({ note: '明天帮你查那个显卡', kind: 'promised', daysAgo: 1 });
  });

  it('does not raise a thread opened minutes ago (that is scratchpad territory)', async () => {
    const m = await load();
    m.rememberThread({ chatId: -100, note: '在等文件', kind: 'waiting' });
    expect(m.listRaiseableThreads(-100, NOW)).toHaveLength(0);
  });

  it('is idempotent per (chat, note)', async () => {
    const m = await load();
    const a = m.rememberThread({ chatId: -100, note: '同一件事', kind: 'promised' });
    const b = m.rememberThread({ chatId: -100, note: '同一件事', kind: 'promised' });
    expect(a).toBe(b);
    expect((db.prepare('SELECT COUNT(*) c FROM open_threads').get() as { c: number }).c).toBe(1);
  });

  it('stops raising a thread after it has been surfaced enough', async () => {
    const m = await load();
    const id = m.rememberThread({ chatId: -100, note: '老事', kind: 'promised' })!;
    db.prepare('UPDATE open_threads SET created_at = ? WHERE id = ?').run(NOW - 90000, id);
    expect(m.listRaiseableThreads(-100, NOW)).toHaveLength(1);
    m.markThreadsSurfaced([id]);
    m.markThreadsSurfaced([id]);
    // A person does not nag about the same thing forever.
    expect(m.listRaiseableThreads(-100, NOW)).toHaveLength(0);
  });

  it('drops threads that are too old to matter', async () => {
    const m = await load();
    const id = m.rememberThread({ chatId: -100, note: '陈年旧事', kind: 'promised' })!;
    db.prepare('UPDATE open_threads SET created_at = ? WHERE id = ?').run(NOW - 30 * 86400, id);
    expect(m.listRaiseableThreads(-100, NOW)).toHaveLength(0);
  });

  it('closes a thread once it has been honoured', async () => {
    const m = await load();
    const id = m.rememberThread({ chatId: -100, note: '办完了', kind: 'promised' })!;
    expect(m.closeThread(id)).toBe(true);
    db.prepare('UPDATE open_threads SET created_at = ? WHERE id = ?').run(NOW - 90000, id);
    expect(m.listRaiseableThreads(-100, NOW)).toHaveLength(0);
    expect(m.closeThread(id)).toBe(false);
  });

  it('keeps chats isolated', async () => {
    const m = await load();
    const id = m.rememberThread({ chatId: -100, note: '甲群的事', kind: 'promised' })!;
    db.prepare('UPDATE open_threads SET created_at = ? WHERE id = ?').run(NOW - 90000, id);
    expect(m.listRaiseableThreads(-200, NOW)).toHaveLength(0);
  });

  it('renders as an opening, not a task', async () => {
    const m = await load();
    const id = m.rememberThread({ chatId: -100, note: '帮你查显卡', kind: 'promised' })!;
    db.prepare('UPDATE open_threads SET created_at = ? WHERE id = ?').run(NOW - 90000, id);
    const text = m.renderOpenThreads(m.listRaiseableThreads(-100, NOW));
    expect(text).toContain('你还记着的事');
    expect(text).toContain('帮你查显卡');
    expect(text).toContain('昨天');
    // The model may legitimately decide the moment has passed.
    expect(text).toContain('也可以不提');
    expect(text).not.toMatch(/必须|应该提|记得要问/);
  });

  it('does nothing when disabled', async () => {
    const m = await load();
    envValues['OPEN_THREADS_ENABLED'] = false;
    expect(m.rememberThread({ chatId: -100, note: 'x', kind: 'promised' })).toBeNull();
    expect(m.listRaiseableThreads(-100, NOW)).toHaveLength(0);
  });
});
