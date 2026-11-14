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

import { canWrite } from '../../../../src/core/blackboard/acl.js';
import {
  writeEntry,
  readEntry,
  setEntryStatus,
  listEntries,
} from '../../../../src/core/blackboard/store.js';

beforeEach(() => {
  envMock.CORE_BLACKBOARD_ENABLED = true;
  db = new Database(':memory:');
  db.exec(readFileSync('migrations/0084_core_blackboard.sql', 'utf8'));
});

describe('blackboard ACL', () => {
  it('L1 只能写 proposal，不能写 authorized_intent', () => {
    expect(canWrite('proposal', 'l1')).toBe(true);
    expect(canWrite('authorized_intent', 'l1')).toBe(false);
    expect(canWrite('plan', 'l1')).toBe(false);
  });

  it('只有 gate 能写 authorized_intent', () => {
    expect(canWrite('authorized_intent', 'gate')).toBe(true);
    expect(canWrite('authorized_intent', 'l2')).toBe(false);
  });

  it('L2 写 plan/execution_receipt，不能写 proposal', () => {
    expect(canWrite('plan', 'l2')).toBe(true);
    expect(canWrite('execution_receipt', 'l2')).toBe(true);
    expect(canWrite('proposal', 'l2')).toBe(false);
  });

  it('writeEntry 拒绝越权写入', () => {
    expect(
      writeEntry({ kind: 'authorized_intent', author: 'l1', content: '{}', chatId: -1 }).ok,
    ).toBe(false);
    expect(db.prepare('SELECT COUNT(*) c FROM core_blackboard').get() as { c: number }).toEqual({
      c: 0,
    });
  });

  it('writeEntry 合法写入 + 状态机推进', () => {
    const r = writeEntry({ kind: 'proposal', author: 'l1', content: '{"x":1}', chatId: -100 });
    expect(r.ok).toBe(true);
    expect(readEntry(r.id!)!.status).toBe('open');
    expect(setEntryStatus(r.id!, 'approved')).toBe(true);
    expect(readEntry(r.id!)!.status).toBe('approved');
  });

  it('总闸关闭时拒绝合法写入、读取和状态推进，保留已有数据', () => {
    const existing = writeEntry({ kind: 'proposal', author: 'l1', content: '{}', chatId: -100 });
    expect(existing.ok).toBe(true);
    envMock.CORE_BLACKBOARD_ENABLED = false;
    expect(writeEntry({ kind: 'proposal', author: 'l1', content: '{}', chatId: -100 })).toEqual({
      ok: false, reason: 'blackboard disabled',
    });
    expect(readEntry(existing.id!)).toBeNull();
    expect(listEntries('proposal', 'open')).toEqual([]);
    expect(setEntryStatus(existing.id!, 'approved')).toBe(false);
    expect(db.prepare('SELECT status FROM core_blackboard').all()).toEqual([{ status: 'open' }]);
  });
});
