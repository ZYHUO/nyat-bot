import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: Database.Database;
const callWithFallbackMock = vi.fn();

vi.mock('../../../src/db/sqlite.js', () => ({
  getDb: () => db,
}));

vi.mock('../../../src/ai/fallback.js', () => ({
  callWithFallback: (...args: unknown[]) => callWithFallbackMock(...args),
}));

vi.mock('../../../src/env.js', () => ({
  env: () => ({ GROUP_NORMS_INFER_USAGE: 'judge' }),
}));

vi.mock('../../../src/shared/config.js', () => ({
  loadCachedPrompt: () => 'group norms system prompt',
}));

const { parseNormsOutput, saveGroupNorms, getGroupNorms, needsRefresh, inferGroupNorms, buildNormsBlock } = await import(
  '../../../src/agent/group-norms.js'
);

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(readFileSync(join(__dirname, '../../../migrations/0063_group_norms.sql'), 'utf8'));
  callWithFallbackMock.mockReset();
});

describe('parseNormsOutput', () => {
  it('parses JSON array, caps at 5, strips short', () => {
    const r = parseNormsOutput('```json\n["玩梗多", "短句", "x", "不聊政治", "技术为主", "深夜活跃", "超长的一条规则超过八十个字会被截断处理"]\n```');
    expect(r.length).toBeLessThanOrEqual(5);
    expect(r).not.toContain('x');
  });

  it('returns empty on garbage', () => {
    expect(parseNormsOutput('')).toEqual([]);
    expect(parseNormsOutput('我不知道')).toEqual([]);
  });
});

describe('saveGroupNorms / getGroupNorms', () => {
  it('roundtrips and rejects DM chatId', () => {
    saveGroupNorms(-100123, ['玩梗多', '短句'], 30);
    const n = getGroupNorms(-100123)!;
    expect(n.norms).toEqual(['玩梗多', '短句']);
    expect(n.sampleCount).toBe(30);
    // DM 不建
    saveGroupNorms(6251541967, ['私聊风格'], 5);
    expect(getGroupNorms(6251541967)).toBeNull();
  });

  it('needsRefresh true when missing or stale', () => {
    expect(needsRefresh(-100123, 3600)).toBe(true);
    saveGroupNorms(-100123, ['短句'], 10);
    expect(needsRefresh(-100123, 3600)).toBe(false);
  });
});

describe('inferGroupNorms', () => {
  it('skips DM and too-few messages', async () => {
    expect(await inferGroupNorms({ chatId: 6251541967, recentMessages: ['a', 'b'] })).toBeNull();
    expect(await inferGroupNorms({ chatId: -100, recentMessages: ['a', 'b', 'c'] })).toBeNull();
  });

  it('infers and saves norms end-to-end', async () => {
    callWithFallbackMock.mockResolvedValue({ content: '["玩梗多", "短句为主"]' });
    const r = await inferGroupNorms({ chatId: -100123, recentMessages: ['哈哈笑死', '绷不住了', '这也行', '草', '哈哈哈哈', '绝了'] });
    expect(r).toEqual(['玩梗多', '短句为主']);
    expect(getGroupNorms(-100123)!.norms).toEqual(['玩梗多', '短句为主']);
  });

  it('unparseable output → null, no save', async () => {
    callWithFallbackMock.mockResolvedValue({ content: '无法判断' });
    const r = await inferGroupNorms({ chatId: -100123, recentMessages: ['a', 'b', 'c', 'd', 'e'] });
    expect(r).toBeNull();
    expect(getGroupNorms(-100123)).toBeNull();
  });
});

describe('buildNormsBlock', () => {
  it('returns empty when no norms', () => {
    expect(buildNormsBlock(-100123)).toBe('');
  });

  it('builds [群氛围] block', () => {
    saveGroupNorms(-100123, ['玩梗多'], 10);
    const b = buildNormsBlock(-100123);
    expect(b).toContain('[群氛围]');
    expect(b).toContain('玩梗多');
  });
});
