import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SHARE_THRESHOLD } from '../../../src/pipeline/rhythm/taste.js';

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
    testDb.exec(readFileSync(resolve(process.cwd(), 'migrations/0082_taste_forward_landing.sql'), 'utf-8'));
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
    expect(s.score).toBeGreaterThanOrEqual(SHARE_THRESHOLD);
    expect(s.reasons.length).toBeGreaterThan(0);
  });

  it('H4.2: single-hit + meaty (0.45) below threshold; double-hit passes', () => {
    // 回放实证："我 turn 没改🤣" funny 单命中 0.35 —— 不够线（防单 emoji 误转）
    expect(scoreTaste(msg('我 turn 没改🤣')).score).toBeLessThan(SHARE_THRESHOLD);
    // funny+useful 双命中 0.7 —— 稳过
    const s = scoreTaste(msg('哈哈哈这个教程太有用了，避坑指南收藏'));
    expect(s.score).toBeGreaterThanOrEqual(SHARE_THRESHOLD);
  });

  it('疑问词不算"有用"（USEFUL_RE 原来含 怎么|如何，把普通提问算成 0.35）', () => {
    // 2026-09-21：摘掉 怎么/如何 之前，这两句各拿 0.35，看着"差一口气就够转"；
    // 摘掉之后是 0——它们只是提问，不是可转发的有用内容。
    expect(scoreTaste(msg('kddi怎么没解锁claude吗？')).score).toBe(0);
    expect(scoreTaste(msg('怎么那么多waifu')).score).toBe(0);
    // 真正的有用内容照旧命中
    expect(scoreTaste(msg('这个避坑指南建议收藏，我亲测有效')).score).toBeGreaterThan(0.3);
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
