import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
let db: Database.Database;
const config = { BOT_TOKEN: '123:synthetic-test', TASK_MAX_ROUNDS: 6, COGNITIVE_EVENTS_ENABLED: false,
  ONEBOT_ENABLED: true, ONEBOT_ACCOUNT_ID: '888' };
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => db }));
vi.mock('../../../src/env.js', () => ({ env: () => config }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { debug: vi.fn(), warn: vi.fn() } }));
import {
  createTask, getTask, claimResearchTask, isResearchClaimCurrent, renewResearchClaim, cancelTask,
  completeTask, retryTask, setTaskState, saveResearchStep, listResearchSteps, beginResearchDelivery,
  recordResearchDelivery, completeResearchClaim, failResearchClaim, listDueTasks, researchJobId,
} from '../../../src/agent/task-store.js';
import { getOrCreateConversationId, getOrCreateUserId } from '../../../src/platform/identity-store.js';

beforeEach(() => {
  db = new Database(':memory:');
  for (const file of readdirSync('migrations').sort()) if (file.endsWith('.sql')) db.exec(readFileSync('migrations/' + file, 'utf8'));
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-14T00:00:00Z'));
  config.BOT_TOKEN = '123:synthetic-test';
  config.ONEBOT_ENABLED = true; config.ONEBOT_ACCOUNT_ID = '888';
});
afterEach(() => { vi.useRealTimers(); db.close(); });
const create = () => createTask({ chatId: -100, ownerUid: 42, goal: 'public research' });
const claim = (taskId: number, owner = 'worker-a') => claimResearchTask({ taskId, chatId: -100, ownerUid: 42,
  wakeGeneration: getTask(taskId)!.wake_generation, owner });

describe('SQLite research execution fence', () => {
  it('allows one owner and fences an expired owner after a successor claim', () => {
    const id = create(), first = claim(id)!;
    expect(claim(id, 'worker-b')).toBeNull();
    vi.setSystemTime(Date.now() + 120_001);
    const second = claim(id, 'worker-b')!;
    expect(second.version).toBe(first.version + 1);
    expect(isResearchClaimCurrent(first)).toBe(false);
    expect(renewResearchClaim(first)).toBe(false);
    expect(saveResearchStep(first, { key: 'search:1', input: {}, result: {} })).toBe(false);
    expect(beginResearchDelivery(first)).toBe(false);
    expect(failResearchClaim(first, 'late')).toBe('stale');
    expect(isResearchClaimCurrent(second)).toBe(true);
  });
  it('makes cancellation terminal against every legacy setter and stale owner', () => {
    const id = create(), owner = claim(id)!;
    cancelTask(id);
    completeTask(id, 'late'); retryTask(id); setTaskState(id, 'pending');
    expect(completeResearchClaim(owner, 'late')).toBe(false);
    expect(failResearchClaim(owner, 'late')).toBe('stale');
    expect(getTask(id)).toMatchObject({ state: 'cancelled', cancel_generation: 1, result: null });
  });
  it('persists successful steps once and resumes them under a successor', () => {
    const id = create(), first = claim(id)!;
    expect(saveResearchStep(first, { key: 'search:1', input: { query: 'a' }, result: { text: 'source-a' } }, 1)).toBe(true);
    saveResearchStep(first, { key: 'search:1', input: {}, result: { text: 'overwrite' } }, 1);
    expect(listResearchSteps(id)[0]?.result).toEqual({ text: 'source-a' });
    expect(failResearchClaim(first, 'summary unavailable')).toBe('retry');
    vi.setSystemTime((getTask(id)!.next_wake! + 1) * 1000);
    expect(claim(id, 'worker-b')).not.toBeNull();
    expect(getTask(id)?.search_round).toBe(1);
    expect(listResearchSteps(id)).toHaveLength(1);
  });
  it('holds a crashed sending attempt instead of assuming non-delivery', () => {
    const id = create(), owner = claim(id)!;
    expect(beginResearchDelivery(owner)).toBe(true);
    vi.setSystemTime(Date.now() + 120_001);
    expect(claim(id, 'worker-b')).toBeNull();
    expect(getTask(id)).toMatchObject({ state: 'blocked', delivery_state: 'unknown', next_wake: null });
    // The old RPC may return late. Its observed ACK is evidence, but cannot
    // reopen or complete the held task under the expired execution owner.
    expect(recordResearchDelivery(owner, 'sent', { messageId: 77 })).toBe(true);
    expect(getTask(id)).toMatchObject({ state: 'blocked', delivery_state: 'sent', next_wake: null });
    expect(completeResearchClaim(owner, 'late')).toBe(false);
    expect(claim(id, 'worker-c')).toBeNull();
  });
  it('retains confirmed delivery after a crash and requires it before completing', () => {
    const id = create(), first = claim(id)!;
    expect(completeResearchClaim(first, 'unconfirmed')).toBe(false);
    beginResearchDelivery(first);
    recordResearchDelivery(first, 'sent', { messageId: 3 });
    vi.setSystemTime(Date.now() + 120_001);
    const second = claim(id, 'worker-b')!;
    expect(beginResearchDelivery(second)).toBe(false);
    expect(completeResearchClaim(second, 'saved result')).toBe(true);
    expect(getTask(id)?.state).toBe('done');
  });
  it('rejects absent provenance and account switches without inferring identity', () => {
    const id = create();
    config.BOT_TOKEN = '456:synthetic-test';
    expect(claim(id)).toBeNull();
    config.BOT_TOKEN = '123:synthetic-test';
    db.prepare('UPDATE tasks SET source_account_id = NULL WHERE id = ?').run(id);
    expect(claim(id)).toBeNull();
  });
  it('binds QQ research to its authenticated account and real mapped owner, including private peer', () => {
    const account = { platform: 'qq' as const, accountId: '888', idNamespace: 'qq-number' as const };
    const chatId = getOrCreateConversationId({ ...account, conversationKind: 'private', id: '42' });
    const ownerUid = getOrCreateUserId({ ...account, id: '42' });
    const id = createTask({ ownerUid, chatId, goal: 'public question' });
    const input = { taskId: id, ownerUid, chatId, wakeGeneration: 0, owner: 'qq-worker' };
    config.ONEBOT_ACCOUNT_ID = '999';
    expect(claimResearchTask(input)).toBeNull();
    config.ONEBOT_ACCOUNT_ID = '888';
    const owner = claimResearchTask(input)!;
    expect(owner).not.toBeNull();
    config.ONEBOT_ENABLED = false;
    expect(isResearchClaimCurrent(owner)).toBe(false);
    config.ONEBOT_ENABLED = true;
    const foreign = getOrCreateUserId({ ...account, accountId: '999', id: '42' });
    const foreignTask = createTask({ chatId, ownerUid: foreign, goal: 'mismatch' });
    expect(claimResearchTask({ ...input, taskId: foreignTask, ownerUid: foreign })).toBeNull();
    const otherPeer = getOrCreateUserId({ ...account, id: '43' });
    const wrongDm = createTask({ chatId, ownerUid: otherPeer, goal: 'wrong peer' });
    expect(claimResearchTask({ ...input, taskId: wrongDm, ownerUid: otherPeer })).toBeNull();
  });
  it('persists initial wake before enqueue and separates retry generations', () => {
    const id = create();
    expect(listDueTasks().map(t => t.id)).toContain(id);
    const jobId = researchJobId(getTask(id)!);
    const owner = claim(id)!;
    failResearchClaim(owner, 'not sent');
    expect(researchJobId(getTask(id)!)).not.toBe(jobId);
    expect(claimResearchTask({ taskId: id, chatId: -100, ownerUid: 42, wakeGeneration: 0, owner: 'old' })).toBeNull();
  });
});
