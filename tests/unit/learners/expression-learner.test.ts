import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseLearnerOutput, upsertExpressions, getTopExpressions } from '../../../src/learners/expression-learner.js';

// Mock sqlite
const mockRun = vi.fn();
const mockAll = vi.fn().mockReturnValue([]);
const mockPrepare = vi.fn().mockReturnValue({ run: mockRun, all: mockAll });
const mockTransaction = vi.fn((fn: () => void) => () => fn());

vi.mock('../../../src/db/sqlite.js', () => ({
  getDb: () => ({ prepare: mockPrepare, transaction: mockTransaction }),
}));

describe('parseLearnerOutput', () => {
  it('parses valid JSON with expressions and jargons', () => {
    const raw = `\`\`\`json
[
  {"situation": "表示震惊", "style": "我勒个豆", "source_id": "3"},
  {"content": "yyds", "source_id": "12"}
]
\`\`\``;
    const result = parseLearnerOutput(raw);
    expect(result.expressions).toHaveLength(1);
    expect(result.expressions[0]).toEqual({ situation: '表示震惊', style: '我勒个豆', source_id: '3' });
    expect(result.jargons).toHaveLength(1);
    expect(result.jargons[0]).toEqual({ content: 'yyds', source_id: '12' });
  });

  it('returns empty on invalid JSON', () => {
    const result = parseLearnerOutput('not json at all');
    expect(result.expressions).toHaveLength(0);
    expect(result.jargons).toHaveLength(0);
  });

  it('truncates long situation/style to 60 chars', () => {
    const long = 'a'.repeat(100);
    const raw = JSON.stringify([{ situation: long, style: long }]);
    const result = parseLearnerOutput(raw);
    expect(result.expressions[0]!.situation).toHaveLength(60);
    expect(result.expressions[0]!.style).toHaveLength(60);
  });

  it('filters out jargon content shorter than 2 chars', () => {
    const raw = JSON.stringify([{ content: 'x' }, { content: 'ab' }]);
    const result = parseLearnerOutput(raw);
    expect(result.jargons).toHaveLength(1);
    expect(result.jargons[0]!.content).toBe('ab');
  });

  it('handles plain JSON without code fences', () => {
    const raw = '[{"situation": "打招呼", "style": "嗨嗨嗨"}]';
    const result = parseLearnerOutput(raw);
    expect(result.expressions).toHaveLength(1);
  });
});

describe('upsertExpressions', () => {
  beforeEach(() => {
    mockRun.mockClear();
    mockPrepare.mockClear();
    mockTransaction.mockClear();
  });

  it('inserts valid expressions and skips empty ones', () => {
    const items = [
      { situation: '表示开心', style: '哈哈哈' },
      { situation: '', style: '空的' },
      { situation: '有内容', style: '' },
    ];
    const count = upsertExpressions(-1001, items);
    expect(count).toBe(1); // only first one is valid
  });

  it('increments count on conflict via ON CONFLICT clause', () => {
    upsertExpressions(-1001, [{ situation: '重复', style: '测试' }]);
    expect(mockPrepare).toHaveBeenCalledWith(expect.stringContaining('ON CONFLICT'));
  });
});

describe('getTopExpressions', () => {
  beforeEach(() => {
    mockAll.mockClear();
  });

  it('returns results ordered by count DESC', () => {
    const fakeRows = [
      { id: 1, chat_id: -1001, situation: 'a', style: 'b', count: 10, source_msg_id: null, created_at: 0, updated_at: 0 },
      { id: 2, chat_id: -1001, situation: 'c', style: 'd', count: 5, source_msg_id: null, created_at: 0, updated_at: 0 },
    ];
    // G10 注入池地板:先查 count>=2(2 行 < 地板 3 → 回退全量查询)
    mockAll.mockReturnValueOnce(fakeRows).mockReturnValueOnce(fakeRows);
    const result = getTopExpressions(-1001, 5);
    expect(result).toEqual(fakeRows);
    expect(mockPrepare).toHaveBeenCalledWith(expect.stringContaining('ORDER BY count DESC'));
  });
});
