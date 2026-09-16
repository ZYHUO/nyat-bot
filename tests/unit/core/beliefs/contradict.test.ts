import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { describe, it, expect, vi, beforeEach } from 'vitest';

let db: Database.Database;
vi.mock('../../../../src/db/sqlite.js', () => ({ getDb: () => db }));
vi.mock('../../../../src/shared/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../../src/ai/fallback.js', () => ({
  callWithFallback: vi.fn(),
}));

import { upsertBelief, getActiveBeliefs } from '../../../../src/core/beliefs/store.js';
import {
  contradict,
  detectSemanticConflicts,
} from '../../../../src/core/beliefs/contradict.js';
import { callWithFallback } from '../../../../src/ai/fallback.js';

function seed(summary: string, evidence = ['msg:1']): number {
  return upsertBelief({
    sourceTable: 'user_profiles',
    sourceRowId: Math.floor(Math.random() * 1e9),
    predicate: 'person.interest',
    summary,
    evidence,
  });
}

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(readFileSync('migrations/0083_core_belief_view.sql', 'utf8'));
  vi.mocked(callWithFallback).mockReset();
});

describe('contradiction', () => {
  it('marks explicit host contradiction → contradicted + refute_count++', () => {
    const id = seed('小明喜欢川菜');
    contradict(id, ['msg:99'], '小明昨天说自己不吃辣');
    const row = db.prepare('SELECT * FROM core_beliefs WHERE id=?').get(id) as {
      status: string;
      refute_count: number;
    };
    expect(row.status).toBe('contradicted');
    expect(row.refute_count).toBe(1);
    const active = getActiveBeliefs('person.interest');
    expect(active.some((b) => b.status === 'contradicted')).toBe(false);
  });

  it('contradict requires evidence', () => {
    const id = seed('小明喜欢川菜');
    expect(() => contradict(id, [], 'no evidence')).toThrow(/evidence/);
  });

  it('semantic conflict detection runs offline, not on hot path', async () => {
    seed('小明喜欢川菜');
    seed('小明不吃辣');
    vi.mocked(callWithFallback).mockResolvedValue({
      content: '[{"a":1,"b":2,"reason":"一个说喜欢川菜一个说不吃辣"}]',
      tokenUsage: { prompt: 0, completion: 0, total: 0 },
      model: 'mock',
      label: 'mock',
      latencyMs: 1,
    });
    const conflicts = await detectSemanticConflicts('person.interest', { usage: 'judge' });
    expect(conflicts).toHaveLength(1);
    expect(vi.mocked(callWithFallback)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(callWithFallback).mock.calls[0]![0].usage).toBe('judge');
  });

  it('semantic detection fail-soft: LLM error → []', async () => {
    seed('a');
    seed('b');
    vi.mocked(callWithFallback).mockRejectedValue(new Error('down'));
    expect(await detectSemanticConflicts('person.interest')).toEqual([]);
  });
});
