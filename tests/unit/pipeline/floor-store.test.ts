import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

let testDb: Database.Database;

vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => testDb }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

const { recordFloorDecision, getFloorStats } = await import('../../../src/pipeline/floor/store.js');

describe('floor store', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.exec(readFileSync(resolve(process.cwd(), 'migrations/0078_floor_decisions.sql'), 'utf-8'));
  });
  afterEach(() => testDb.close());

  it('record + stats roundtrip', () => {
    recordFloorDecision({ chatId: -1001, messageId: 5, verdict: 'to_me', reason: 'mention_self' });
    recordFloorDecision({ chatId: -1001, messageId: 6, verdict: 'ambient', reason: 'ambient' });
    recordFloorDecision({ chatId: -1001, messageId: 7, verdict: 'not_me', reason: 'duet_no_interrupt' });
    const s = getFloorStats(-1001, 7);
    expect(s.total).toBe(3);
    expect(s.to_me).toBe(1);
    expect(s.ambient).toBe(1);
    expect(s.not_me).toBe(1);
    expect(s.to_other).toBe(0);
  });

  it('other chat isolated', () => {
    recordFloorDecision({ chatId: -1001, messageId: 5, verdict: 'to_me', reason: 'x' });
    expect(getFloorStats(-2002, 7).total).toBe(0);
  });
});
