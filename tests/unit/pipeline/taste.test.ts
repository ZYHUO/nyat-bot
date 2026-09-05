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
  scoreTaste, recordForward, wasForwardedRecently,
} = await import('../../../src/pipeline/rhythm/taste.js');

function msg(text: string, extra: Record<string, unknown> = {}) {
  return {
    role: 'user' as const, uid: 1001, username: 'alice', fullName: 'Alice',
    timestamp: 1700000000, messageId: 1, textContent: text, isForwarded: false, ...extra,
  };
}

describe('taste scoring', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.exec(readFileSync(resolve(process.cwd(), 'migrations/0080_taste_forwards.sql'), 'utf-8'));
  });
  afterEach(() => testDb.close());

  it('empty / noise → 0', () => {
    expect(scoreTaste(msg('')).score).toBe(0);
    expect(scoreTaste(msg('嗯')).score).toBe(0);
    expect(scoreTaste(msg('5.00% [1/20]')).score).toBe(0);
    expect(scoreTaste(msg('[media]')).score).toBe(0);
  });

  it('funny meme text with reactions → high', () => {
    const s = scoreTaste(msg('哈哈哈笑死我了，典中典', { messageId: 42 }), { reactions: ['😂', '👍', '❤'] });
    expect(s.score).toBeGreaterThanOrEqual(0.6);
    expect(s.reasons.length).toBeGreaterThan(0);
  });

  it('bot own / command / ad → 0', () => {
    expect(scoreTaste({ ...msg('哈哈哈'), role: 'assistant' as const }).score).toBe(0);
    expect(scoreTaste(msg('/start')).score).toBe(0);
    expect(scoreTaste(msg('机场优惠19.9包月 https://x.com')).score).toBe(0);
  });

  it('same msg id within 7d → suppressed', () => {
    recordForward(-1001, 42, 0.8);
    expect(wasForwardedRecently(-1001, 42)).toBe(true);
    expect(wasForwardedRecently(-1001, 43)).toBe(false);
  });

  it('record + get recent forwards', async () => {
    recordForward(-1001, 42, 0.8);
    const { getRecentForwards } = await import('../../../src/pipeline/rhythm/taste.js');
    expect(getRecentForwards(-1001, 7)).toEqual([42]);
  });
});
