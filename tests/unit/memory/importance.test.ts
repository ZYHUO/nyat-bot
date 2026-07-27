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
  setProtection, getProtection, PROTECTION,
} = await import('../../../src/memory/importance.js');

function initSchema(db: Database.Database): void {
  // 按顺序灌真实 migration —— 0052 给 memory_meta 加了 protection 列,
  // 只灌 0030 的话 getForgettableIds 会因为缺列而静默返回空。
  for (const f of ['migrations/0030_memory_meta.sql', 'migrations/0052_memory_protection.sql']) {
    db.exec(readFileSync(resolve(process.cwd(), f), 'utf-8'));
  }
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

  // migration 0052。人设级事实(生日/称呼/雷区)很少被检索命中,在旧口径下
  // (ref_count = 0 且超龄 → 删)会和普通闲聊一起被遗忘,而这类遗忘不可逆。
  describe('保护档(protection)', () => {
    const old = () => now - 40 * DAY;

    it('默认是 NONE,不改变既有遗忘行为', () => {
      recordMemoryCreated('-100_cold', -100, old());
      expect(getProtection(['-100_cold']).get('-100_cold')).toBe(PROTECTION.NONE);
      expect(getForgettableIds(-100, 30, 100)).toEqual(['-100_cold']);
    });

    it('PROTECTED 的记忆不再被遗忘,即使又老又从没被召回过', () => {
      recordMemoryCreated('-100_persona', -100, old());
      setProtection(['-100_persona'], PROTECTION.PROTECTED);
      expect(getForgettableIds(-100, 30, 100)).toEqual([]);
    });

    it('PERMANENT 同样不被遗忘', () => {
      recordMemoryCreated('-100_birthday', -100, old());
      setProtection(['-100_birthday'], PROTECTION.PERMANENT);
      expect(getForgettableIds(-100, 30, 100)).toEqual([]);
    });

    it('只挡住被保护的那些,其余照常遗忘', () => {
      recordMemoryCreated('-100_keep', -100, old());
      recordMemoryCreated('-100_drop', -100, old());
      setProtection(['-100_keep'], PROTECTION.PROTECTED);
      expect(getForgettableIds(-100, 30, 100)).toEqual(['-100_drop']);
    });

    it('可以降级回 NONE,之后重新可被遗忘', () => {
      recordMemoryCreated('-100_x', -100, old());
      setProtection(['-100_x'], PROTECTION.PROTECTED);
      expect(getForgettableIds(-100, 30, 100)).toEqual([]);
      setProtection(['-100_x'], PROTECTION.NONE);
      expect(getForgettableIds(-100, 30, 100)).toEqual(['-100_x']);
    });

    it('setProtection 返回实际更新行数,未知 id 不计入', () => {
      recordMemoryCreated('-100_a', -100, now);
      expect(setProtection(['-100_a', '-100_nonexistent'], PROTECTION.PROTECTED)).toBe(1);
    });

    it('空数组是 no-op', () => {
      expect(setProtection([], PROTECTION.PROTECTED)).toBe(0);
      expect(getProtection([]).size).toBe(0);
    });

    it('保护档不阻止显式删除', () => {
      recordMemoryCreated('-100_x', -100, now);
      setProtection(['-100_x'], PROTECTION.PERMANENT);
      deleteMeta(['-100_x']);
      expect(getRefCounts(['-100_x']).size).toBe(0);
    });

    it('PERMANENT 在重要度上加权,PROTECTED 不加', () => {
      const base = importanceScore(now, 0, now, PROTECTION.NONE);
      expect(importanceScore(now, 0, now, PROTECTION.PROTECTED)).toBe(base);
      expect(importanceScore(now, 0, now, PROTECTION.PERMANENT)).toBeGreaterThan(base);
    });

    it('importanceScore 省略 protection 时与旧签名等价(向后兼容)', () => {
      expect(importanceScore(now - 7 * DAY, 3)).toBe(importanceScore(now - 7 * DAY, 3, Math.floor(Date.now() / 1000), PROTECTION.NONE));
    });
  });
});
