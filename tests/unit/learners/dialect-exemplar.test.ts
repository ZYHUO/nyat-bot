import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

let testDb: Database.Database;

vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => testDb }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }), warn: vi.fn(), debug: vi.fn(), info: vi.fn() },
}));

const {
  pickExemplars, saveExemplars, getExemplars, needsExemplars,
} = await import('../../../src/learners/dialect-exemplar.js');

describe('dialect exemplar', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.exec(readFileSync(resolve(process.cwd(), 'migrations/0079_dialect_exemplar.sql'), 'utf-8'));
  });
  afterEach(() => testDb.close());

  it('empty group → needsExemplars true', () => {
    expect(needsExemplars(-1001)).toBe(true);
    expect(getExemplars(-1001)).toEqual([]);
  });

  it('pickExemplars: dedups near-identical + caps at 10', () => {
    const msgs = [
      '哈哈哈笑死我了',
      '哈哈哈笑死我了！', // 近似重复 → 只留一条
      '这个需求什么时候上线啊',
      '上线了跟我说一声',
      ' unrelated english spam '.repeat(3),
      '好的收到',
      '明天开会别迟到',
      '记得带电脑',
      '楼下奶茶第二杯半价',
      '冲！',
      '今晚加班到十点',
      '周报写完了吗',
    ];
    const picked = pickExemplars(msgs);
    expect(picked.length).toBeLessThanOrEqual(10);
    // 近似重复被去重
    expect(picked.filter((s) => s.includes('笑死我了')).length).toBe(1);
  });

  it('pickExemplars: skips bot own messages via marker', () => {
    const picked = pickExemplars(['SELF: 我是bot', '真人说话味儿呀']);
    expect(picked.some((s) => s.includes('我是bot'))).toBe(false);
  });

  it('pickExemplars: filters noise (progress bars, source_id residue, pure symbols)', () => {
    const picked = pickExemplars([
      '5.00%     [1/20]',
      '[=                   ]',
      '[source_id:225332] 喵锵: /invite@KairoClaw_bot',
      '快乐小鳄鱼: [media]',
      '冲！',
      '嗯',
      '楼下奶茶第二杯半价啦',
    ]);
    expect(picked).toEqual(['楼下奶茶第二杯半价啦']);
  });

  it('save + get roundtrip', () => {
    saveExemplars(-1001, ['哈哈哈笑死', '冲！']);
    expect(needsExemplars(-1001)).toBe(false);
    expect(getExemplars(-1001)).toEqual(['哈哈哈笑死', '冲！']);
  });

  it('DM → empty + needsExemplars false (不建)', () => {
    expect(needsExemplars(12345)).toBe(false);
    saveExemplars(12345, ['x']);
    expect(getExemplars(12345)).toEqual([]);
  });
});
