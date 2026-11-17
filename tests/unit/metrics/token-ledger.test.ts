import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

let testDb: Database.Database;
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => testDb }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { llmEvents, emitLlmResult } from '../../../src/ai/events.js';
import type { AITokenUsage } from '../../../src/ai/types.js';
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

  it('persists paired cache coverage, weighting by covered tokens rather than averaging request percentages', () => {
    const send = (tokenUsage: AITokenUsage) => emitLlmResult('reply', { content: 'synthetic', label: 'provider',
      model: 'model-a', transportPath: 'openai_json', latencyMs: 1, tokenUsage });
    send({ prompt: 100, completion: 10, total: 110, cached: 100, inputKnown: true });
    send({ prompt: 900, completion: 20, total: 920, cached: 0, cacheWrite: 200, inputKnown: true });
    send({ prompt: 2000, completion: 30, total: 2030, inputKnown: true });
    send({ prompt: 500, completion: 40, total: 540, cached: 400, inputKnown: false });
    const report = getTokenReport();
    expect(report.readFailed).toBe(false);
    expect(report.byRoute).toHaveLength(1);
    expect(report.byRoute[0]).toMatchObject({ label: 'provider', usage: 'reply', model: 'model-a', path: 'openai_json',
      prompt: 3500, cached: 500, coveredInputTokens: 1000, cacheReadTokens: 100,
      cacheWriteTokens: 200, cacheHitRatio: 0.1, observedInputTokens: 3000,
      observedResults: 4, knownCacheResults: 2, unknownCacheResults: 2, unknownInputResults: 1,
      knownWriteResults: 1, unknownWriteResults: 3, cacheReportingRate: 0.5,
      historicalCoverage: 'tracked', legacyPromptTokens: 0, uncoveredPromptTokens: 2500 });
    expect(report.byLabel[0]?.cacheHitRatio).toBe(0.1);
    expect(report.total.cacheHitRatio).toBe(0.1);
    // Read the persisted report again: no duplicate increments or in-memory-only ratio.
    expect(getTokenReport()).toEqual(report);
  });

  it('keeps old rows untracked and never pairs their cached tokens with the new denominator', () => {
    const date = new Date().toISOString().slice(0, 10);
    const insert = testDb.prepare('INSERT INTO llm_token_daily (date,label,usage,kind,tokens) VALUES (?,?,?,?,?)');
    insert.run(date, 'provider', 'reply', 'prompt', 9000);
    insert.run(date, 'provider', 'reply', 'cached', 8000);
    const old = getTokenReport();
    expect(old.total).toMatchObject({ prompt: 9000, cached: 8000, coveredInputTokens: 0,
      cacheHitRatio: null, cacheReportingRate: null, observedResults: 0, historicalCoverage: 'untracked', legacyPromptTokens: 9000 });
    expect(old.byRoute).toEqual([]);
    emitLlmResult('reply', { content: '', label: 'provider', model: 'model-a', transportPath: 'openai_sdk',
      latencyMs: 1, tokenUsage: { prompt: 100, completion: 1, total: 101, inputKnown: true, cached: 20 } });
    const mixed = getTokenReport();
    expect(mixed.total).toMatchObject({ prompt: 9100, cached: 8020, coveredInputTokens: 100,
      cacheReadTokens: 20, cacheHitRatio: 0.2, historicalCoverage: 'partial', legacyPromptTokens: 9000 });
    expect(mixed.byRoute[0]?.historicalCoverage).toBe('tracked');
  });

  it('keeps explicit zero distinct from unknown and zero-token input has no percentage', () => {
    for (const [label, tokenUsage] of [
      ['miss', { prompt: 100, completion: 0, total: 100, inputKnown: true, cached: 0 }],
      ['unknown', { prompt: 100, completion: 0, total: 100, inputKnown: true }],
      ['zero', { prompt: 0, completion: 0, total: 0, inputKnown: true, cached: 0 }],
    ] as const) emitLlmResult('reply', { content: '', label, model: 'm', latencyMs: 0, tokenUsage });
    const rows = getTokenReport().byLabel;
    expect(rows.find(row => row.label === 'miss')).toMatchObject({ cacheHitRatio: 0, knownCacheResults: 1 });
    expect(rows.find(row => row.label === 'unknown')).toMatchObject({ cacheHitRatio: null, unknownCacheResults: 1 });
    expect(rows.find(row => row.label === 'zero')).toMatchObject({ cacheHitRatio: null, knownCacheResults: 1, observedResults: 1 });
  });

  it('retains model, path and usage partitions within a configured provider alias', () => {
    for (const [usage, model, transportPath] of [
      ['reply', 'model-a', 'openai_sdk'], ['judge', 'model-a', 'openai_sdk'],
      ['reply', 'model-b', 'openai_sdk'], ['reply', 'model-a', 'openai_stream'],
    ] as const) emitLlmResult(usage, { content: '', label: 'same-provider', model, transportPath,
      latencyMs: 1, tokenUsage: { prompt: 100, completion: 1, total: 101, cached: 50, inputKnown: true } });
    const report = getTokenReport();
    expect(report.byRoute).toHaveLength(4);
    expect(report.byRoute.every(row => row.coveredInputTokens === 100 && row.cacheHitRatio === 0.5)).toBe(true);
    expect(report.byLabel).toHaveLength(1);
    expect(report.total.prompt).toBe(400);
    expect(report.total.observedResults).toBe(4);
  });

  it('ignores malformed, unknown-version and unsafe metadata kinds without corrupting legacy totals', () => {
    const date = new Date().toISOString().slice(0, 10);
    const insert = testDb.prepare('INSERT INTO llm_token_daily (date,label,usage,kind,tokens) VALUES (?,?,?,?,?)');
    for (const kind of ['cache_v2:not-json', 'cache_v3:["m","openai_sdk","read"]',
      'cache_v2:["https://invalid.example","openai_sdk","read"]',
      'cache_v2:["m","unsupported","read"]', 'cache_v2:["m","openai_sdk","unknown-kind"]']) {
      insert.run(date, 'fixture', 'reply', kind, 9999);
    }
    insert.run(date, 'fixture', 'reply', 'prompt', 100);
    const report = getTokenReport();
    expect(report.byRoute).toEqual([]);
    expect(report.total).toMatchObject({ prompt: 100, cacheReadTokens: 0, cacheHitRatio: null, historicalCoverage: 'untracked' });
    expect(JSON.stringify(report)).not.toContain('invalid.example');
  });
});
