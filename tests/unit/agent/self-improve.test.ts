import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// P3-3: real :memory: DB + real tmp prompts dir — no more writes to repo prompts/,
// no more mocked getDb. Catches the prompts/task/x.md leak class by construction.
let db: Database.Database;
let promptsDir: string;
const origCwd = process.cwd();

vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => db }));
vi.mock('../../../src/env.js', () => ({
  env: () => ({ SELF_EDIT_GUARDRAILS_ENABLED: true }),
}));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const mod = await import('../../../src/agent/self-improve.js');

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(readFileSync('migrations/0056_self_model.sql', 'utf8'));
  promptsDir = mkdtempSync(join(tmpdir(), 'nyat-prompts-'));
  process.env['NYAT_PROMPTS_DIR'] = join(promptsDir, 'prompts');
  mod.__resetSelfEditCooldownForTest();
});

afterEach(() => {
  delete process.env['NYAT_PROMPTS_DIR'];
});

describe('self-edit guardrails', () => {
  it('rejects self-edit within cooldown', () => {
    const first = mod.selfEditPrompt('task/x.md', 'a'.repeat(100), 'first', { skipFsForTest: 'x'.repeat(100) });
    expect(first.ok).toBe(true);
    const second = mod.selfEditPrompt('task/y.md', 'b'.repeat(100), 'second', { skipFsForTest: 'y'.repeat(100) });
    expect(second.ok).toBe(false);
    expect(second.reason).toMatch(/cooldown/);
  });

  it('rejects oversized prompt rewrites', () => {
    const r = mod.selfEditPrompt('task/x.md', 'c'.repeat(20000), 'too big', { skipCooldownForTest: true });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/too large/);
  });
});

describe('self-edit motive rowid (P3-2)', () => {
  it('returns motiveRowid and stores the motive note', () => {
    mkdirSync(join(process.env['NYAT_PROMPTS_DIR']!, 'task'), { recursive: true });
    writeFileSync(join(process.env['NYAT_PROMPTS_DIR']!, 'task/real.md'), '# old', 'utf-8');
    const r = mod.selfEditPrompt('task/real.md', '# real content', 'why change', { skipCooldownForTest: true });
    expect(r.ok).toBe(true);
    expect(r.motiveRowid).toBeGreaterThan(0);
    const row = db.prepare('SELECT note FROM self_model_notes WHERE rowid = ?').get(r.motiveRowid) as { note: string };
    expect(row.note).toContain('task/real.md');
    expect(row.note).toContain('why change');
  });

  it('recordMotive returns rowid directly', () => {
    const id = mod.recordMotive('task/direct.md', 'direct motive');
    expect(id).toBeGreaterThan(0);
    const { c } = db.prepare('SELECT COUNT(*) AS c FROM self_model_notes').get() as { c: number };
    expect(c).toBe(1);
  });
});
