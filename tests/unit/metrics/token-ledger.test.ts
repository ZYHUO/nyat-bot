import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

let testDb: Database.Database;
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => testDb }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { llmEvents } from '../../../src/ai/events.js';
import { initTokenLedger, flushTokenLedger, getTokenReport } from '../../../src/metrics/token-ledger.js';

function emit(usage: string, label: string, prompt: number, completion: number, cached = 0, outcome: 'ok' | 'error' = 'ok'): void {
  llmEvents.emit('result', { usage, label, model: 'm', outcome, latencyMs: 1, promptTokens: prompt, completionTokens: completion, cachedTokens: cached });
}

beforeEach(() => {
  testDb = new Database(':memory:');
  testDb.exec(readFileSync(resolve(process.cwd(), 'migrations/0048_llm_token_ledger.sql'), 'utf-8'));
  initTokenLedger(); // 幂等,只订阅一次
  flushTokenLedger(); // 清掉可能的残留
});

describe('token-ledger', () => {
  it('累加 prompt/completion/cached 并按 provider 汇总', () => {
    emit('reply', 'stepfun', 1000, 200, 300);
    emit('reply', 'stepfun', 500, 100, 0);
    emit('summarize', 'stepfunjudge', 2000, 50, 0);
    const r = getTokenReport();
    const step = r.byLabel.find((x) => x.label === 'stepfun')!;
    expect(step.prompt).toBe(1500);
    expect(step.completion).toBe(300);
    expect(step.cached).toBe(300);
    expect(step.total).toBe(1800); // cached 不另加
    const judge = r.byLabel.find((x) => x.label === 'stepfunjudge')!;
    expect(judge.total).toBe(2050);
    expect(r.total.total).toBe(1800 + 2050);
  });

  it('error 事件不计 token', () => {
    emit('reply', 'longcat', 9999, 9999, 0, 'error');
    const r = getTokenReport();
    expect(r.byLabel.find((x) => x.label === 'longcat')).toBeUndefined();
  });

  it('flush 后持久化(重读 DB 仍在)', () => {
    emit('judge', 'stepfun', 100, 20, 0);
    flushTokenLedger();
    const row = testDb.prepare("SELECT SUM(tokens) t FROM llm_token_daily WHERE label='stepfun' AND kind='prompt'").get() as { t: number };
    expect(row.t).toBe(100);
  });

  it('按 provider 排序(总量降序)', () => {
    emit('reply', 'small', 10, 1, 0);
    emit('reply', 'big', 5000, 500, 0);
    const r = getTokenReport();
    expect(r.byLabel[0]!.label).toBe('big');
  });
});
