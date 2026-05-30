import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

let testDb: Database.Database;

vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => testDb }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

const {
  importanceScore, recordMemoryCreated, recordMemoryReferenced,
  getRefCounts, getForgettableIds, deleteMeta, chatsWithMemory,
} = await import('../../../src/memory/importance.js');

function initSchema(db: Database.Database): void {
  db.exec(readFileSync(resolve(process.cwd(), 'migrations/0030_memory_meta.sql'), 'utf-8'));
}
const DAY = 86400;
const now = Math.floor(Date.now() / 1000);

describe('memory importance', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    initSchema(testDb);
  });
  afterEach(() => testDb.close());

  describe('importanceScore', () => {
    it('fresh + unreferenced ≈ 1', () => {
      expect(importanceScore(now, 0, now)).toBeCloseTo(1, 2);
    });
    it('decays with age (half-life 14d)', () => {
      expect(importanceScore(now - 14 * DAY, 0, now)).toBeCloseTo(0.5, 2);
    });
    it('references boost importance', () => {
      expect(importanceScore(now, 5, now)).toBeGreaterThan(importanceScore(now, 0, now));
    });
  });

  describe('create / reference / forget lifecycle', () => {
    it('records creation and references', () => {
      recordMemoryCreated('-100_1', -100, now);
      recordMemoryCreated('-100_2', -100, now - 40 * DAY);
      recordMemoryReferenced(['-100_1']);
      recordMemoryReferenced(['-100_1']);
      expect(getRefCounts(['-100_1', '-100_2']).get('-100_1')).toBe(2);
      expect(getRefCounts(['-100_2']).get('-100_2')).toBe(0);
    });

    it('getForgettableIds returns old + never-referenced only', () => {
      recordMemoryCreated('-100_fresh', -100, now);                 // too new
      recordMemoryCreated('-100_old_ref', -100, now - 40 * DAY);    // old but referenced
      recordMemoryCreated('-100_old_cold', -100, now - 40 * DAY);   // old + never referenced → forget
      recordMemoryReferenced(['-100_old_ref']);

      const forgettable = getForgettableIds(-100, 30, 100);
      expect(forgettable).toEqual(['-100_old_cold']);
    });

    it('deleteMeta removes rows', () => {
      recordMemoryCreated('-100_x', -100, now);
      deleteMeta(['-100_x']);
      expect(getRefCounts(['-100_x']).size).toBe(0);
    });

    it('chatsWithMemory lists distinct chats', () => {
      recordMemoryCreated('-100_a', -100, now);
      recordMemoryCreated('-200_a', -200, now);
      expect(chatsWithMemory().sort()).toEqual([-200, -100].sort());
    });
  });
});
