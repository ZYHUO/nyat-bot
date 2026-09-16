import { describe, it, expect, vi } from 'vitest';
import { explainJargon } from '../../../src/learners/jargon-explainer.js';

const mockGet = vi.fn();
const mockAll = vi.fn().mockReturnValue([]);
const mockPrepare = vi.fn().mockReturnValue({ get: mockGet, all: mockAll, run: vi.fn() });

vi.mock('../../../src/db/sqlite.js', () => ({
  getDb: () => ({ prepare: mockPrepare }),
}));

vi.mock('../../../src/ai/fallback.js', () => ({
  callWithFallback: vi.fn(),
}));

vi.mock('../../../src/shared/config.js', () => ({
  loadCachedPrompt: vi.fn().mockReturnValue('test prompt'),
}));

describe('explainJargon', () => {
  it('returns exact match explanation', () => {
    mockGet.mockReturnValueOnce({ id: 1, chat_id: -1001, content: 'yyds', meaning: '永远的神', count: 10, status: 'inferred', raw_samples: '[]', created_at: 0, updated_at: 0 });
    const result = explainJargon(-1001, 'yyds');
    expect(result).toBe('「yyds」：永远的神');
  });

  it('is case-sensitive for exact match', () => {
    mockGet.mockReturnValueOnce(undefined);
    mockAll.mockReturnValueOnce([]);
    const result = explainJargon(-1001, 'YYDS');
    expect(result).toBe('未找到「YYDS」的含义记录。');
  });

  it('falls back to fuzzy search when no exact match', () => {
    mockGet.mockReturnValueOnce(undefined);
    mockAll.mockReturnValueOnce([
      { id: 1, chat_id: -1001, content: 'yyds', meaning: '永远的神', count: 10, status: 'inferred', raw_samples: '[]', created_at: 0, updated_at: 0 },
    ]);
    const result = explainJargon(-1001, 'yyd');
    expect(result).toContain('「yyds」：永远的神');
  });

  it('returns unknown message when no matches found', () => {
    mockGet.mockReturnValueOnce(undefined);
    mockAll.mockReturnValueOnce([]);
    const result = explainJargon(-1001, 'unknown_term');
    expect(result).toBe('未找到「unknown_term」的含义记录。');
  });

  it('returns exact match even if meaning is present (ignores fuzzy)', () => {
    mockGet.mockReturnValueOnce({ id: 1, chat_id: -1001, content: 'xswl', meaning: '笑死我了', count: 5, status: 'inferred', raw_samples: '[]', created_at: 0, updated_at: 0 });
    const result = explainJargon(-1001, 'xswl');
    expect(result).toBe('「xswl」：笑死我了');
    // fuzzy search should not be called
  });
});
