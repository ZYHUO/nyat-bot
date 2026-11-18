import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const f = vi.hoisted(() => ({ dir: '', afterListing: undefined as (() => void) | undefined }));
vi.mock('better-sqlite3', async importOriginal => {
  const { default: Database } = await importOriginal<typeof import('better-sqlite3')>();
  return { default: function openFixture(path: string) {
    if (path !== ':memory:' || !f.dir) throw new Error('expected isolated test connection');
    return new Database(join(f.dir, 'test.sqlite'));
  } };
});
vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs, readdirSync: (dir: string) => {
    const result = fs.readdirSync(dir);
    if (dir === f.dir && f.afterListing) {
      const hook = f.afterListing;
      f.afterListing = undefined;
      hook();
    }
    return result;
  } };
});
vi.mock('../../../src/env.js', () => ({ env: () => ({}) }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { info: vi.fn(), debug: vi.fn() } }));

type Runner = typeof import('../../../src/db/sqlite.js');
let first: Runner, peer: Runner;
beforeEach(async () => {
  f.dir = mkdtempSync(join(tmpdir(), 'nyat-migration-'));
  // Separate module instances own two independently opened WAL connections.
  vi.resetModules(); first = await import('../../../src/db/sqlite.js');
  vi.resetModules(); peer = await import('../../../src/db/sqlite.js');
});
afterEach(() => {
  first.closeDb(); peer.closeDb();
  rmSync(f.dir, { recursive: true, force: true }); f.dir = ''; f.afterListing = undefined;
});

describe('SQLite migration ownership', () => {
  it('applies 0135 once when another startup commits after the first runner read its ledger', () => {
    const previous = '0134_telegram_heart_batches.sql', next = '0135_telegram_heart_source_wait.sql';
    writeFileSync(join(f.dir, previous), readFileSync(join('migrations', previous)));
    first.runMigrations(f.dir);
    writeFileSync(join(f.dir, next), readFileSync(join('migrations', next)));
    f.afterListing = () => peer.runMigrations(f.dir);
    first.runMigrations(f.dir);
    for (const runner of [first, peer]) {
      expect(runner.getDb().prepare('SELECT name FROM _migrations ORDER BY name').all()).toEqual([{ name: previous }, { name: next }]);
      expect(runner.getDb().prepare("SELECT COUNT(*) AS n FROM pragma_table_info('telegram_heart_candidates') WHERE name='wait_until_ms'").get()).toEqual({ n: 1 });
    }
  });

  it('rolls back both the mark and partial DDL on a genuine error and permits a corrected retry', () => {
    const name = '0001_retry.sql', migration = join(f.dir, name);
    writeFileSync(migration, 'CREATE TABLE test_retry(id INTEGER); INSERT INTO _migrations(missing_column) VALUES (1);');
    expect(() => first.runMigrations(f.dir)).toThrow(/missing_column/);
    const db = peer.getDb();
    expect(db.prepare('SELECT name FROM _migrations').all()).toEqual([]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='test_retry'").get()).toBeUndefined();
    writeFileSync(migration, 'CREATE TABLE test_retry(id INTEGER);');
    peer.runMigrations(f.dir);
    expect(db.prepare('SELECT name FROM _migrations').all()).toEqual([{ name }]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='test_retry'").get()).toEqual({ name: 'test_retry' });
  });
});
