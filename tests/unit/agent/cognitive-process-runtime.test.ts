import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let db: Database.Database;

vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => db }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { requestProcessWake, listDueProcessWakes } from '../../../src/agent/cognitive-continuity.js';
import { runCognitiveProcessTick } from '../../../src/agent/cognitive-process-runtime.js';

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(readFileSync('migrations/0089_cognitive_events.sql', 'utf8'));
});

afterEach(() => db.close());

describe('cognitive process runtime', () => {
  it('checkpoints a durable non-chat wake and schedules its next wake', async () => {
    const wake = requestProcessWake({
      processId: 'global:observer',
      kind: 'observer',
      scope: { visibility: 'global' },
      wakeAt: 1_700_000_000,
      reason: 'startup',
    });
    expect(wake?.inserted).toBe(true);

    const result = await runCognitiveProcessTick(1_700_000_001);
    expect(result).toMatchObject({ claimed: 1, completed: 1, projected: 0, rescheduled: 1 });
    expect(listDueProcessWakes(1_700_000_001)).toHaveLength(0);
    expect(listDueProcessWakes(1_700_000_901)).toHaveLength(1);
  });

  it('does not let a failed projection become a completion', async () => {
    const wake = requestProcessWake({
      processId: 'chat:social',
      kind: 'social_mind',
      scope: { visibility: 'chat', chatId: -100 },
      wakeAt: 1_700_000_000,
      reason: 'message_received',
    });
    expect(wake?.inserted).toBe(true);

    const result = await runCognitiveProcessTick(1_700_000_001);
    expect(result.failed).toBe(1);
    expect(result.completed).toBe(0);
    expect(result.rescheduled).toBe(1);
    expect(listDueProcessWakes(1_700_000_301)).toHaveLength(1);
  });
});
