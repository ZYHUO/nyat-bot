import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let db: Database.Database;
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => db }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { appendCognitiveEvent, listCognitiveOutbox } from '../../../src/agent/cognitive-events.js';
import { drainCognitiveOutbox, CognitiveOutboxWorker } from '../../../src/agent/cognitive-outbox-worker.js';

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(readFileSync('migrations/0089_cognitive_events.sql', 'utf8'));
  db.exec(readFileSync('migrations/0091_cognitive_outbox.sql', 'utf8'));
});

describe('cognitive outbox worker', () => {
  it('handles a claimed event and acknowledges it durably', async () => {
    const appended = appendCognitiveEvent({
      type: 'task_observation',
      source: 'host',
      scope: { visibility: 'task', taskId: 'task-1', chatId: -100 },
      correlationId: 'task-1',
      fact: { kind: 'task_started' },
    });
    const seen: string[] = [];
    const result = await drainCognitiveOutbox((item) => {
      seen.push(item.event?.id ?? 'missing');
    }, { workerId: 'worker-a' });

    expect(result).toEqual({ claimed: 1, delivered: 1, retried: 0, failed: 0 });
    expect(seen).toEqual([appended!.event.id]);
    expect(listCognitiveOutbox('delivered')).toHaveLength(1);
  });

  it('marks a permanently failing item after max attempts', async () => {
    appendCognitiveEvent({ type: 'tool_failure', source: 'tool', correlationId: 'failure-1' });
    const result = await drainCognitiveOutbox(() => { throw new Error('projection unavailable'); }, {
      workerId: 'worker-a',
      retryInSec: 0,
      maxAttempts: 1,
    });

    expect(result).toEqual({ claimed: 1, delivered: 0, retried: 0, failed: 1 });
    expect(listCognitiveOutbox('failed')[0]?.lastError).toBe('projection unavailable');
  });

  it('prevents overlapping drains and can be stopped', async () => {
    const worker = new CognitiveOutboxWorker(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }, { workerId: 'worker-a', pollMs: 60_000 });
    expect(worker.start()).toBe(true);
    expect(worker.start()).toBe(false);
    expect(worker.isRunning()).toBe(true);
    expect(worker.stop()).toBe(true);
    expect(worker.stop()).toBe(false);
  });
});

