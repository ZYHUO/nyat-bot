import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';

let db: Database.Database;
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => db }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const {
  createDebt, listOpenDebts, findRelatedDebts, resolveDebt,
  supersedeDebt, snoozeDebt, expireStaleDebts,
} = await import('../../../src/agent/cognitive-debts.js');

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(readFileSync('migrations/0087_cognitive_debts.sql', 'utf8'));
});

describe('cognitive debts', () => {
  it('creates and lists scoped open debts by priority', () => {
    const low = createDebt({ chatId: -100, kind: 'uncertainty', statement: '服务是否跑路尚未确认', priority: 3 });
    const high = createDebt({ chatId: -100, kind: 'promise', statement: '答应主人查项目更新', priority: 8 });
    const other = createDebt({ chatId: -200, kind: 'promise', statement: '别的群的债务' });
    expect(low).not.toBeNull();
    expect(high).not.toBeNull();
    expect(other).not.toBeNull();
    const open = listOpenDebts(-100);
    expect(open.map((d) => d.id)).toEqual([high, low]);
  });

  it('matches related debts by gram overlap and resolves them', () => {
    createDebt({ chatId: -100, kind: 'promise', statement: '答应帮主人查 nyatdb 项目更新' });
    const hits = findRelatedDebts(-100, 'nyatdb 项目更新查到了吗');
    expect(hits).toHaveLength(1);
    expect(resolveDebt(hits[0]!.id, '已确认最新版本并回复主人')).toBe(true);
    expect(listOpenDebts(-100)).toHaveLength(0);
    expect(findRelatedDebts(-100, 'nyatdb 项目更新查到了吗')).toHaveLength(0);
  });

  it('supersedes stale beliefs and snoozes retries', () => {
    const old = createDebt({ chatId: -100, kind: 'correction', statement: '主人环境是 Ubuntu 的旧判断' });
    const fresh = createDebt({ chatId: -100, kind: 'stale_belief', statement: '主人环境已改为 Windows，需要重查' });
    expect(supersedeDebt(old!, fresh, '用户已纠正环境')).toBe(true);
    expect(snoozeDebt(fresh!, 3600)).toBe(true);
    const open = listOpenDebts(-100);
    expect(open).toHaveLength(1);
    expect(open[0]!.id).toBe(fresh);
    expect(open[0]!.nextCheckAt).not.toBeNull();
  });

  it('expires overdue open debts', () => {
    const ts = Math.floor(Date.now() / 1000);
    createDebt({ chatId: -100, kind: 'uncertainty', statement: '临时传闻待核', ttlSec: 60 });
    db.prepare(`UPDATE cognitive_debts SET expires_at = ? WHERE chat_id = -100`).run(ts - 120);
    expect(expireStaleDebts()).toBe(1);
    expect(listOpenDebts(-100)).toHaveLength(0);
  });
});
