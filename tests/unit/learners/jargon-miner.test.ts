import { describe, it, expect, vi, beforeEach } from 'vitest';
import { upsertJargons, getJargonsForInference, markJargonInferred, queryJargon, searchJargons } from '../../../src/learners/jargon-miner.js';

const mockRun = vi.fn();
const mockAll = vi.fn().mockReturnValue([]);
const mockGet = vi.fn().mockReturnValue(undefined);
const mockPrepare = vi.fn().mockReturnValue({ run: mockRun, all: mockAll, get: mockGet });
const mockTransaction = vi.fn((fn: () => void) => () => fn());

vi.mock('../../../src/db/sqlite.js', () => ({
  getDb: () => ({ prepare: mockPrepare, transaction: mockTransaction }),
}));

describe('upsertJargons', () => {
  beforeEach(() => {
    mockRun.mockClear();
    mockPrepare.mockClear();
  });

  it('inserts valid jargons and skips empty content', () => {
    const items = [
      { content: 'yyds' },
      { content: '' },
      { content: 'xswl' },
    ];
    const count = upsertJargons(-1001, items);
    expect(count).toBe(2);
  });

  it('uses ON CONFLICT to increment count', () => {
    upsertJargons(-1001, [{ content: 'test' }]);
    expect(mockPrepare).toHaveBeenCalledWith(expect.stringContaining('ON CONFLICT'));
  });
});

describe('getJargonsForInference', () => {
  beforeEach(() => {
    mockAll.mockClear();
  });

  it('returns pending jargons above minimum threshold', () => {
    const fakeRows = [
      { id: 1, chat_id: -1001, content: 'yyds', raw_samples: '[]', meaning: '', count: 5, status: 'pending', created_at: 0, updated_at: 0 },
    ];
    mockAll.mockReturnValueOnce(fakeRows);
    const result = getJargonsForInference(-1001, [4, 8, 25]);
    expect(result).toEqual(fakeRows);
    // #8: query now allows re-inferring already-'inferred' jargons (refinement),
    // excluding only manually-locked 'confirmed' ones.
    expect(mockPrepare).toHaveBeenCalledWith(expect.stringContaining("status != 'confirmed'"));
  });

  it('returns empty array when thresholds is empty', () => {
    const result = getJargonsForInference(-1001, []);
    expect(result).toEqual([]);
  });

  it('uses minimum threshold value for query', () => {
    mockAll.mockReturnValueOnce([]);
    getJargonsForInference(-1001, [8, 4, 25]);
    // Should use min threshold = 4
    expect(mockPrepare).toHaveBeenCalledWith(expect.stringContaining('count >= ?'));
  });
});

describe('markJargonInferred', () => {
  beforeEach(() => {
    mockRun.mockClear();
  });

  it('updates status to inferred with meaning', () => {
    markJargonInferred(-1001, 'yyds', '永远的神');
    expect(mockRun).toHaveBeenCalledWith('永远的神', expect.any(Number), -1001, 'yyds');
  });
});

describe('queryJargon', () => {
  it('returns exact match', () => {
    const entry = { id: 1, chat_id: -1001, content: 'yyds', meaning: '永远的神', count: 10, status: 'inferred', raw_samples: '[]', created_at: 0, updated_at: 0 };
    mockGet.mockReturnValueOnce(entry);
    const result = queryJargon(-1001, 'yyds');
    expect(result).toEqual(entry);
  });

  it('returns undefined for non-existent term', () => {
    mockGet.mockReturnValueOnce(undefined);
    const result = queryJargon(-1001, 'nonexistent');
    expect(result).toBeUndefined();
  });
});

describe('searchJargons', () => {
  it('returns fuzzy matches with LIKE pattern', () => {
    mockAll.mockReturnValueOnce([]);
    searchJargons(-1001, 'yy');
    expect(mockPrepare).toHaveBeenCalledWith(expect.stringContaining('LIKE'));
  });
});
