import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let db: Database.Database;
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => db }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { appendCognitiveEvent } from '../../../src/agent/cognitive-events.js';
import {
  buildAblationMatrix,
  runPairedReplayEvaluation,
  type EvaluationVariant,
} from '../../../src/eval/agi-like-evaluator.js';

const variants: EvaluationVariant[] = [
  { id: 'legacy-off', mode: 'legacy', memory: false, skill: false, predictionUpdate: false },
  { id: 'core-on', mode: 'core', memory: true, skill: true, predictionUpdate: true },
];

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(readFileSync('migrations/0089_cognitive_events.sql', 'utf8'));
  db.exec(readFileSync('migrations/0091_cognitive_outbox.sql', 'utf8'));
  db.exec(readFileSync('migrations/0098_replay_experiments.sql', 'utf8'));
});

describe('AGI-like paired replay evaluator', () => {
  it('builds the complete deterministic legacy/core ablation matrix', () => {
    const matrix = buildAblationMatrix();
    expect(matrix).toHaveLength(16);
    expect(new Set(matrix.map((variant) => variant.id)).size).toBe(16);
    expect(matrix[0]).toMatchObject({ mode: 'legacy', memory: false, skill: false, predictionUpdate: false });
    expect(matrix.at(-1)).toMatchObject({ mode: 'core', memory: true, skill: true, predictionUpdate: true });
  });

  it('gives every variant the same frozen event slice and reports paired metrics', async () => {
    appendCognitiveEvent({
      type: 'message_received', source: 'telegram',
      scope: { visibility: 'chat', chatId: -100 }, correlationId: 'eval-1',
      fact: { messageId: 1 },
    });
    appendCognitiveEvent({
      type: 'task_observation', source: 'host',
      scope: { visibility: 'task', chatId: -100, taskId: 'task-1' }, correlationId: 'eval-1',
      fact: { kind: 'task_completed' },
    });
    const references: readonly unknown[][] = [];
    let expectedEventIds: string[] | undefined;
    const report = await runPairedReplayEvaluation({
      cases: [{ id: 'case-1', correlationId: 'eval-1' }],
      variants,
      execute: ({ variant, events }) => {
        references.push(events);
        expect(Object.isFrozen(events)).toBe(true);
        expect(Object.isFrozen(events[0])).toBe(true);
        if (!expectedEventIds) expectedEventIds = events.map((event) => event.id);
        else expect(events.map((event) => event.id)).toEqual(expectedEventIds);
        return variant.mode === 'core'
          ? { status: 'verified', latencyMs: 12, llmCalls: 1, toolCalls: 2, metrics: { retention: 1 } }
          : { status: 'failed', latencyMs: 24, llmCalls: 1, toolCalls: 3, repairAttempts: 1 };
      },
    });
    expect(report.cases[0]!.eventIds).toEqual(expectedEventIds);
    expect(references).toHaveLength(2);
    expect(references[0]).toBe(references[1]);
    expect(report.variants[0]).toMatchObject({ samples: 1, failed: 1, verified: 0, successRate: 0 });
    expect(report.variants[1]).toMatchObject({ samples: 1, failed: 0, verified: 1, successRate: 1, meanLatencyMs: 12 });
    expect(report.comparisons[0]).toMatchObject({ comparable: 1, baselineWins: 0, variantWins: 1, successDelta: 1 });
    expect(report.comparisons[0]!.successCi95).toEqual({ low: -1, high: 1 });
    expect(report.evidence).toMatchObject({
      sampleCount: 1,
      eventTimeRange: expect.objectContaining({ from: expect.any(Number), to: expect.any(Number) }),
      failureSamples: expect.arrayContaining([
        expect.objectContaining({ caseId: 'case-1', variantId: 'legacy-off', status: 'failed' }),
      ]),
    });
    expect(report.evidence.uncertainty).toEqual(expect.arrayContaining([
      'code_version_missing', 'config_snapshot_missing', 'experiment_group_missing', 'small_sample',
    ]));
  });

  it('converts executor exceptions to blocked cases and persists bounded metadata idempotently', async () => {
    appendCognitiveEvent({
      type: 'user_correction', source: 'telegram',
      scope: { visibility: 'chat', chatId: -200 }, correlationId: 'eval-2',
      fact: { reason: 'redacted from report' },
    });
    const run = (throwForCore: boolean) => runPairedReplayEvaluation({
      experimentId: 'experiment-1',
      codeVersion: 'test-version',
      experimentGroup: 'replay-smoke',
      configSnapshot: { memory: true, rollout: 'shadow' },
      metadata: { owner: 'offline', secretLike: 'x'.repeat(500) },
      persist: true,
      cases: [{ id: 'case-2', correlationId: 'eval-2' }],
      variants,
      execute: ({ variant }) => {
        if (throwForCore && variant.id === 'core-on') throw new Error('private exception must not persist');
        return { status: 'unverified', errorCode: 'no_acceptance' };
      },
    });
    const first = await run(true);
    expect(first.persisted).toBe(true);
    expect(first.variants[1]).toMatchObject({ blocked: 1, samples: 1 });
    expect(first.evidence).toMatchObject({
      codeVersion: 'test-version',
      experimentGroup: 'replay-smoke',
      configSnapshot: { memory: true, rollout: 'shadow' },
      failureSamples: expect.arrayContaining([
        expect.objectContaining({ variantId: 'core-on', status: 'blocked', errorCode: 'executor_error' }),
      ]),
    });
    expect(first.evidence.uncertainty).toContain('blocked_cases_present');
    expect(first.comparisons[0]).toMatchObject({ comparable: 0, successDelta: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM replay_experiments').get()).toEqual({ count: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM replay_experiment_cases').get()).toEqual({ count: 2 });
    const config = db.prepare('SELECT config_json FROM replay_experiments WHERE id = ?').get('experiment-1') as { config_json: string };
    expect(config.config_json).toContain('offline');
    expect(config.config_json).toContain('replay-smoke');
    expect(config.config_json).not.toContain('private exception');
    const second = await run(false);
    expect(second.persisted).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS count FROM replay_experiments').get()).toEqual({ count: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM replay_experiment_cases').get()).toEqual({ count: 2 });
  });

  it('rejects duplicate case or variant identifiers before reading events', async () => {
    await expect(runPairedReplayEvaluation({
      cases: [{ id: 'same', correlationId: 'missing' }, { id: 'same', correlationId: 'missing' }],
      variants,
      execute: () => ({ status: 'verified' }),
    })).rejects.toThrow('duplicate case id');
    await expect(runPairedReplayEvaluation({
      cases: [{ id: 'case', correlationId: 'missing' }],
      variants: [variants[0]!, { ...variants[1]!, id: variants[0]!.id }],
      execute: () => ({ status: 'verified' }),
    })).rejects.toThrow('duplicate variant id');
  });
});
