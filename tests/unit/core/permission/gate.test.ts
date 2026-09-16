import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { describe, it, expect, vi, beforeEach } from 'vitest';

let db: Database.Database;
vi.mock('../../../../src/db/sqlite.js', () => ({ getDb: () => db }));
vi.mock('../../../../src/shared/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { classify } from '../../../../src/core/permission/tiers.js';
import {
  approve,
  gateConfirm,
  _resetGateForTest,
} from '../../../../src/core/permission/gate.js';
import { writeEntry } from '../../../../src/core/blackboard/store.js';

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(readFileSync('migrations/0084_core_blackboard.sql', 'utf8'));
  _resetGateForTest();
});

describe('permission gate', () => {
  it('classify: 只读工具 → readonly', () => {
    expect(classify('memory.search', {})).toBe('readonly');
    expect(classify('web.search', {})).toBe('readonly');
  });

  it('classify: computer.run 里 DROP → irreversible', () => {
    expect(classify('computer.run', { command: 'DROP TABLE users' })).toBe('irreversible');
    expect(classify('computer.run', { command: 'rm -rf /data' })).toBe('irreversible');
    expect(classify('computer.run', { command: 'echo hi' })).toBe('reversible_write');
  });

  it('classify: 未知工具 fail-closed → irreversible', () => {
    expect(classify('nuke.everything', {})).toBe('irreversible');
  });

  it('readonly 直接放行', async () => {
    expect((await approve('readonly', 'intent-1')).ok).toBe(true);
  });

  it('reversible_write 需要 authorized_intent', async () => {
    expect((await approve('reversible_write', 'intent-x')).ok).toBe(false);
    const r = writeEntry({
      kind: 'authorized_intent',
      author: 'gate',
      content: '{"scope":"send"}',
      chatId: -100,
    });
    expect(r.ok).toBe(true);
    expect((await approve('reversible_write', r.id!)).ok).toBe(true);
  });

  it('irreversible 必须 intent + 用户确认（一次性，防重放）', async () => {
    expect((await approve('irreversible', 'intent-y')).ok).toBe(false);
    const r = writeEntry({
      kind: 'authorized_intent',
      author: 'gate',
      content: '{"scope":"admin"}',
      chatId: -100,
    });
    // 有 intent 但无确认 → 仍拒绝
    expect((await approve('irreversible', r.id!)).ok).toBe(false);
    gateConfirm(r.id!, { userId: 6251541967 });
    expect((await approve('irreversible', r.id!)).ok).toBe(true);
    // consumed，一次性：第二次再用同一个 intent → 拒绝
    gateConfirm(r.id!, { userId: 6251541967 });
    expect((await approve('irreversible', r.id!)).ok).toBe(false);
  });
});
