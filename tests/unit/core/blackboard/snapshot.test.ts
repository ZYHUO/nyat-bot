import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { describe, it, expect, vi, beforeEach } from 'vitest';

let db: Database.Database;
const envMock = vi.hoisted(() => ({ CORE_BLACKBOARD_ENABLED: true }));
vi.mock('../../../../src/env.js', () => ({ env: () => envMock }));
vi.mock('../../../../src/db/sqlite.js', () => ({ getDb: () => db }));
vi.mock('../../../../src/shared/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  freezeBeliefSnapshot,
  getBeliefSnapshot,
  visibleToL1,
  _resetSnapshotForTest,
} from '../../../../src/core/blackboard/snapshot.js';
import { writeEntry, readEntry, setEntryStatus } from '../../../../src/core/blackboard/store.js';

beforeEach(() => {
  envMock.CORE_BLACKBOARD_ENABLED = true;
  db = new Database(':memory:');
  db.exec(readFileSync('migrations/0084_core_blackboard.sql', 'utf8'));
  _resetSnapshotForTest();
});

describe('snapshot isolation', () => {
  it('L1 看不到 L2 的中间态，只看得到完成的 receipt', () => {
    freezeBeliefSnapshot(-100, []);
    expect(getBeliefSnapshot(-100)).toEqual([]);
    const r = writeEntry({
      kind: 'execution_receipt',
      author: 'l2',
      content: '{"partial":true}',
      chatId: -100,
    });
    expect(r.ok).toBe(true);
    // open = 中间态 → L1 不可见
    expect(visibleToL1(readEntry(r.id!))).toBe(false);
    setEntryStatus(r.id!, 'consumed');
    // 完成 → L1 可见
    expect(visibleToL1(readEntry(r.id!))).toBe(true);
  });

  it('非 receipt 条目 L1 本来就有读权', () => {
    const r = writeEntry({ kind: 'proposal', author: 'l1', content: '{}', chatId: -100 });
    expect(visibleToL1(readEntry(r.id!))).toBe(true);
  });

  it('总闸关闭时已完成 receipt 也不能经读取路径暴露给 L1', () => {
    const r = writeEntry({ kind: 'execution_receipt', author: 'l2', content: '{}', chatId: -100 });
    expect(r.ok).toBe(true);
    expect(setEntryStatus(r.id!, 'consumed')).toBe(true);
    envMock.CORE_BLACKBOARD_ENABLED = false;
    expect(readEntry(r.id!)).toBeNull();
    expect(visibleToL1(readEntry(r.id!))).toBe(false);
    expect(db.prepare('SELECT status FROM core_blackboard WHERE id = ?').get(r.id!)).toEqual({
      status: 'consumed',
    });
  });

  it('快照是冻结拷贝，后续 belief 变化不影响快照', () => {
    const beliefs = [
      { id: 1, summary: 'v1', status: 'active' },
    ] as never as Parameters<typeof freezeBeliefSnapshot>[1];
    freezeBeliefSnapshot(-100, beliefs);
    beliefs[0]!.summary = 'v2-mutated';
    expect(getBeliefSnapshot(-100)![0]!.summary).toBe('v1');
  });
});
