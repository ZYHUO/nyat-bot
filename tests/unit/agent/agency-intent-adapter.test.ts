import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let db: Database.Database;
const envState: Record<string, unknown> = {
  AGENCY_RUNTIME_MODE: 'shadow',
  AGENCY_CANARY_CHAT_IDS: [],
  AGENCY_MAX_LLM_CALLS: 2,
  AGENCY_MAX_TOOL_CALLS: 8,
  AGENCY_FAIL_CLOSED: true,
  COGNITIVE_EVENTS_ENABLED: true,
  COGNITIVE_OUTBOX_ENABLED: true,
};

vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => db }));
vi.mock('../../../src/env.js', () => ({ env: () => envState }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../src/memory/chroma.js', () => ({
  searchMemory: vi.fn(async () => [{ text: 'hit' }]),
}));
vi.mock('../../../src/pipeline/context/manager.js', () => ({
  getRecent: vi.fn(async () => []),
}));
vi.mock('../../../src/pipeline/tools/search.js', () => ({
  executeSearch: vi.fn(async (query: string) => `results for ${query}`),
}));

import { executeAuthorizedIntentViaAgency } from '../../../src/agent/agency-intent-adapter.js';
import { writeEntry } from '../../../src/core/blackboard/store.js';
import { searchMemory } from '../../../src/memory/chroma.js';

function makeIntent(tool: string, args: unknown): string {
  const result = writeEntry({
    kind: 'authorized_intent',
    author: 'gate',
    content: JSON.stringify({ tool, args, why: 'test' }),
    chatId: -100,
  });
  if (!result.ok || !result.id) throw new Error('intent write failed');
  return result.id;
}

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(readFileSync('migrations/0084_core_blackboard.sql', 'utf8'));
  db.exec(readFileSync('migrations/0089_cognitive_events.sql', 'utf8'));
  db.exec(readFileSync('migrations/0091_cognitive_outbox.sql', 'utf8'));
  db.exec(readFileSync('migrations/0092_agency_runs.sql', 'utf8'));
  db.exec(readFileSync('migrations/0095_agency_attempts_receipts.sql', 'utf8'));
  envState.AGENCY_RUNTIME_MODE = 'shadow';
  vi.mocked(searchMemory).mockClear();
});

describe('authorized readonly intent -> Agency', () => {
  it('shadow 持久化 waiting，不调用 host tool，也不消费 intent', async () => {
    const intentId = makeIntent('memory.search', { query: '猫', chatId: -100 });
    const result = await executeAuthorizedIntentViaAgency(intentId);

    expect(result.executed).toBe(false);
    expect(result.deferred).toBe(true);
    expect(result.reason).toBe('policy:shadow_only');
    expect(vi.mocked(searchMemory)).not.toHaveBeenCalled();
    expect(db.prepare('SELECT status FROM core_blackboard WHERE id = ?').get(intentId)).toEqual({ status: 'open' });
    expect(db.prepare('SELECT status, action_json FROM agency_runs WHERE id = ?').get(result.agencyRunId)).toMatchObject({ status: 'waiting' });
    expect(JSON.parse((db.prepare('SELECT action_json FROM agency_runs WHERE id = ?').get(result.agencyRunId) as { action_json: string }).action_json)).toEqual({
      type: 'observe',
      target: 'l2-read:memory.search',
      args: { query: '猫', chatId: -100 },
    });
  });

  it('advisory 调用 readonly adapter，成功后消费 intent 并写兼容 receipt', async () => {
    envState.AGENCY_RUNTIME_MODE = 'advisory';
    const intentId = makeIntent('memory.search', { query: '猫', chatId: -100 });
    const result = await executeAuthorizedIntentViaAgency(intentId);

    expect(result.executed).toBe(true);
    expect(result.data).toEqual([{ text: 'hit' }]);
    expect(result.agencyRunId).toEqual(expect.any(String));
    expect(result.receiptId).toEqual(`agency-receipt:${result.agencyRunId}`);
    expect(vi.mocked(searchMemory)).toHaveBeenCalledWith(-100, '猫');
    expect(db.prepare('SELECT status FROM core_blackboard WHERE id = ?').get(intentId)).toEqual({ status: 'consumed' });
    expect(db.prepare('SELECT status FROM agency_runs WHERE id = ?').get(result.agencyRunId)).toEqual({ status: 'succeeded' });
    expect(db.prepare('SELECT status FROM core_blackboard WHERE id = ?').get(result.receiptId)).toEqual({ status: 'consumed' });
    expect(db.prepare('SELECT status FROM execution_receipts WHERE run_id = ?').get(result.agencyRunId)).toEqual({ status: 'succeeded' });
  });

  it('advisory 仍拒绝跨群 recentMessages 参数', async () => {
    envState.AGENCY_RUNTIME_MODE = 'advisory';
    const intentId = makeIntent('chats.recentMessages', { chatId: -200 });
    const result = await executeAuthorizedIntentViaAgency(intentId);

    expect(result.executed).toBe(false);
    expect(result.reason).toContain('scope violation');
    expect(db.prepare('SELECT status FROM agency_runs WHERE id = ?').get(result.agencyRunId)).toEqual({ status: 'failed' });
  });
});
