import { describe, it, expect, vi, beforeEach } from 'vitest';
import { upsertJargons, getJargonsForInference, markJargonInferred, queryJargon, searchJargons, getTopJargons, getTopJargonsForContext, detectJargonDomain } from '../../../src/learners/jargon-miner.js';

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

  it('B: writes the domain column, defaulting to general (insert carries domain)', () => {
    upsertJargons(-1001, [{ content: '三网绕', domain: 'infra' }, { content: 'yyds' }]);
    expect(mockPrepare).toHaveBeenCalledWith(expect.stringContaining('domain'));
    // run args: (chatId, content, sample, domain, now, now)
    expect(mockRun).toHaveBeenCalledWith(-1001, '三网绕', expect.any(String), 'infra', expect.any(Number), expect.any(Number));
    expect(mockRun).toHaveBeenCalledWith(-1001, 'yyds', expect.any(String), 'general', expect.any(Number), expect.any(Number));
  });
});

describe('getTopJargons', () => {
  beforeEach(() => {
    mockAll.mockClear();
    mockPrepare.mockClear();
  });

  it('B: filters by domain when one is supplied', () => {
    mockAll.mockReturnValueOnce([]);
    getTopJargons(-1001, 5, 'infra');
    expect(mockPrepare).toHaveBeenCalledWith(expect.stringContaining('domain = ?'));
    expect(mockAll).toHaveBeenCalledWith(-1001, 'infra', 5);
  });

  it('B: omits the domain filter when none is supplied', () => {
    mockAll.mockReturnValueOnce([]);
    getTopJargons(-1001, 5);
    expect(mockPrepare).not.toHaveBeenCalledWith(expect.stringContaining('domain = ?'));
    expect(mockAll).toHaveBeenCalledWith(-1001, 5);
  });
});

describe('detectJargonDomain (B)', () => {
  it('detects infra from VPS/机场/线路 vocabulary', () => {
    expect(detectJargonDomain('这个机场的三网绕线路怎么样')).toBe('infra');
    expect(detectJargonDomain('小鸡测速丢包严重')).toBe('infra');
    expect(detectJargonDomain('解锁流媒体吗')).toBe('infra');
  });

  it('returns undefined for non-infra / empty text', () => {
    expect(detectJargonDomain('今天天气真好哈哈哈')).toBeUndefined();
    expect(detectJargonDomain('')).toBeUndefined();
  });
});

describe('getTopJargonsForContext (B)', () => {
  beforeEach(() => {
    mockAll.mockClear();
    mockPrepare.mockClear();
  });

  it('biases toward the detected domain, topping up with global highs (deduped)', () => {
    const infraRow = { id: 1, chat_id: -1001, content: '三网绕', meaning: 'm', count: 9, status: 'inferred', raw_samples: '[]', domain: 'infra', created_at: 0, updated_at: 0 };
    const globalRows = [
      infraRow, // duplicate — must be filtered out
      { id: 2, chat_id: -1001, content: 'yyds', meaning: 'm2', count: 8, status: 'inferred', raw_samples: '[]', domain: 'general', created_at: 0, updated_at: 0 },
    ];
    // 1st all() = domain query, 2nd all() = global fill
    mockAll.mockReturnValueOnce([infraRow]).mockReturnValueOnce(globalRows);
    const result = getTopJargonsForContext(-1001, '机场线路问题', 5);
    expect(result.map((j) => j.content)).toEqual(['三网绕', 'yyds']);
  });

  it('falls back to plain top jargons when no domain is detected', () => {
    mockAll.mockReturnValueOnce([]);
    getTopJargonsForContext(-1001, '随便聊聊', 5);
    // single global query, no domain filter
    expect(mockAll).toHaveBeenCalledWith(-1001, 5);
    expect(mockPrepare).not.toHaveBeenCalledWith(expect.stringContaining('domain = ?'));
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
