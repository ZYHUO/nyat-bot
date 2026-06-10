import { describe, it, expect, vi, beforeEach } from 'vitest';
import { selectExpressions } from '../../../src/learners/expression-selector.js';
import type { ExpressionEntry } from '../../../src/learners/types.js';

const mockAll = vi.fn().mockReturnValue([]);
const mockPrepare = vi.fn().mockReturnValue({ all: mockAll, run: vi.fn() });

vi.mock('../../../src/db/sqlite.js', () => ({
  getDb: () => ({ prepare: mockPrepare }),
}));

vi.mock('../../../src/ai/fallback.js', () => ({
  callWithFallback: vi.fn().mockResolvedValue({ content: '{"selected_situations": [0, 2]}' }),
}));

vi.mock('../../../src/shared/config.js', () => ({
  loadCachedPrompt: vi.fn().mockReturnValue('test prompt'),
}));

function makeEntry(id: number, situation: string, count: number): ExpressionEntry {
  return { id, chat_id: -1001, situation, style: `style_${id}`, count, source_msg_id: null, created_at: 0, updated_at: 0 };
}

describe('selectExpressions', () => {
  beforeEach(() => {
    mockAll.mockClear();
  });

  it('returns empty array when no expressions exist', async () => {
    mockAll.mockReturnValueOnce([]);
    const result = await selectExpressions(-1001, '日常聊天', 5, 'judge');
    expect(result).toEqual([]);
  });

  it('returns all when count <= maxCount', async () => {
    const entries = [makeEntry(1, 'a', 10), makeEntry(2, 'b', 5)];
    // G10 地板:count>=2 查询(2 行 < 3)→ 回退全量查询
    mockAll.mockReturnValueOnce(entries).mockReturnValueOnce(entries);
    const result = await selectExpressions(-1001, '日常聊天', 5, 'judge');
    expect(result).toEqual(entries);
  });

  it('uses LLM to select when more than maxCount available', async () => {
    const entries = Array.from({ length: 10 }, (_, i) => makeEntry(i + 1, `situation_${i}`, 10 - i));
    mockAll.mockReturnValueOnce(entries);
    const result = await selectExpressions(-1001, '日常聊天', 3, 'judge');
    // LLM returns [0, 2], so we get entries at index 0 and 2
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(entries[0]);
    expect(result[1]).toEqual(entries[2]);
  });

  it('respects maxCount limit', async () => {
    const entries = Array.from({ length: 10 }, (_, i) => makeEntry(i + 1, `situation_${i}`, 10 - i));
    mockAll.mockReturnValueOnce(entries);
    const result = await selectExpressions(-1001, '日常聊天', 2, 'judge');
    expect(result.length).toBeLessThanOrEqual(2);
  });

  it('falls back to top-by-count on LLM failure', async () => {
    const { callWithFallback } = await import('../../../src/ai/fallback.js');
    vi.mocked(callWithFallback).mockRejectedValueOnce(new Error('LLM error'));
    const entries = Array.from({ length: 10 }, (_, i) => makeEntry(i + 1, `situation_${i}`, 10 - i));
    mockAll.mockReturnValueOnce(entries);
    const result = await selectExpressions(-1001, '日常聊天', 3, 'judge');
    expect(result).toHaveLength(3);
    // Should be top 3 by count (already sorted)
    expect(result).toEqual(entries.slice(0, 3));
  });
});
