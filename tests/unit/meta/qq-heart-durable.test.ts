import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QqHeartCandidate } from '../../../src/meta/qq-heart-batch.js';
const f = vi.hoisted(() => ({ db: undefined as unknown as Database.Database, recalled: vi.fn(), answered: vi.fn(),
  config: { DURABLE_INGRESS_ENABLED: true, ONEBOT_ENABLED: true, ONEBOT_ACCOUNT_ID: '123', ONEBOT_ALLOWED_GROUP_IDS: '',
    META_QQ_GROUP_COALESCE_MS: 1500, META_QQ_GROUP_COALESCE_MAX_MS: 4000 } }));
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => f.db }));
vi.mock('../../../src/env.js', () => ({ env: () => f.config }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn() } }));
vi.mock('../../../src/platform/onebot-notices.js', () => ({ isOneBotMessageRecalled: f.recalled }));
vi.mock('../../../src/meta/answered.js', () => ({ isMessageAnswered: f.answered }));
import { _resetQqHeartBatches, closeQqHeartBatches, drainQqHeartBatches, enqueueQqHeartBatch, startQqHeartBatchRecovery } from '../../../src/meta/qq-heart-batch.js';
import { getOrCreateConversationId, getOrCreateMessageId, getOrCreateUserId } from '../../../src/platform/identity-store.js';
import { createMessageEventIdentity, eventHash } from '../../../src/shared/event-identity.js';
import { acceptInbox, expireInboxClaims, getInboxEntry, listPendingInbox } from '../../../src/ingress/inbox-store.js';
const item = (id: number, group = '999'): QqHeartCandidate => {
  const conversation = { platform: 'qq' as const, idNamespace: 'qq-number' as const, accountId: '123', conversationKind: 'group' as const, id: group };
  const ref = { conversation, id: String(id) };
  return { chatId: getOrCreateConversationId(conversation), layer: 'L2', addressed: id === 1,
    formatted: { role: 'user', uid: getOrCreateUserId({ platform: 'qq', accountId: '123', idNamespace: 'qq-number', id: '88' }),
      username: '', fullName: 'synthetic', timestamp: 50, messageId: getOrCreateMessageId(ref), textContent: `condition ${id}`, isForwarded: false,
      eventIdentity: createMessageEventIdentity({ ref, occurredAt: 50000 }) } };
};
const entryId = (candidate: QqHeartCandidate) => eventHash('qq-heart:' + candidate.formatted.eventIdentity!.eventId);
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(100000); f.db = new Database(':memory:');
  f.db.exec(readFileSync('migrations/0118_platform_identity.sql', 'utf8'));
  f.db.exec(readFileSync('migrations/0125_durable_ingress.sql', 'utf8'));
  f.config.ONEBOT_ALLOWED_GROUP_IDS = ''; f.config.ONEBOT_ACCOUNT_ID = '123';
  vi.clearAllMocks(); f.recalled.mockReturnValue(false); f.answered.mockResolvedValue(false); _resetQqHeartBatches(); });
afterEach(async () => { await drainQqHeartBatches(); vi.clearAllTimers(); vi.useRealTimers(); f.db.close(); });
describe('durable QQ pre-Heart handoff', () => {
  it('persists 3 real references before timer and recovers the unstarted batch after restart', async () => {
    const before = vi.fn(async (_items: QqHeartCandidate[], _signal: AbortSignal) => {});
    const recovered = vi.fn(async (_items: QqHeartCandidate[], _signal: AbortSignal) => {});
    const inputs: QqHeartCandidate[] = [];
    for (let i = 1; i <= 3; i++) { const candidate = item(i); inputs.push(candidate); enqueueQqHeartBatch(candidate, before);
      if (i !== 3) await vi.advanceTimersByTimeAsync(1000); }
    expect(listPendingInbox('qq_heart')).toHaveLength(3); expect(before).not.toHaveBeenCalled();
    _resetQqHeartBatches(); startQqHeartBatchRecovery(recovered);
    await vi.advanceTimersByTimeAsync(1500);
    expect(recovered).toHaveBeenCalledOnce(); expect(recovered.mock.calls[0]![0]).toMatchObject(inputs);
    expect(inputs.map(input => getInboxEntry(entryId(input))?.state)).toEqual(['settled', 'settled', 'settled']);
    await vi.advanceTimersByTimeAsync(5000); expect(recovered).toHaveBeenCalledOnce();
  });
  it('does not turn started failures into replayable pending decisions', async () => {
    const candidate = item(1); const process = vi.fn(async () => { throw new Error('possible reaction occurred'); });
    enqueueQqHeartBatch(candidate, process); await vi.advanceTimersByTimeAsync(1500);
    expect(getInboxEntry(entryId(candidate))?.state).toBe('unknown');
    _resetQqHeartBatches(); startQqHeartBatchRecovery(process); await vi.advanceTimersByTimeAsync(5000);
    expect(process).toHaveBeenCalledOnce();
  });
  it('fences an expired owner after a stalled answered lookup before Heart can run', async () => {
    let release!: (value: boolean) => void;
    f.answered.mockImplementation(() => new Promise<boolean>(resolve => { release = resolve; }));
    const candidate = item(1), process = vi.fn(async () => {});
    enqueueQqHeartBatch(candidate, process); await vi.advanceTimersByTimeAsync(1500);
    expect(getInboxEntry(entryId(candidate))?.state).toBe('processing');
    // Simulate suspension: wall clock moves while heartbeat timers do not run.
    vi.setSystemTime(Date.now() + 121000); expect(expireInboxClaims()).toBe(1);
    release(false); await vi.advanceTimersByTimeAsync(0);
    expect(process).not.toHaveBeenCalled(); expect(getInboxEntry(entryId(candidate))?.state).toBe('unknown');
  });
  it('retains the original candidate text across a pending duplicate after restart', async () => {
    const candidate = item(1), process = vi.fn(async (_items: QqHeartCandidate[], _signal: AbortSignal) => {});
    enqueueQqHeartBatch(candidate, process); _resetQqHeartBatches();
    enqueueQqHeartBatch({ ...candidate, formatted: { ...candidate.formatted, textContent: 'changed retransmission' } }, process);
    await vi.advanceTimersByTimeAsync(1500);
    expect(process.mock.calls[0]![0][0]!.formatted.textContent).toBe('condition 1');
  });
  it('leaves pending candidates untouched until the recovery owner is ready/awake', async () => {
    const candidate = item(1), process = vi.fn(async () => {}); let ready = false;
    enqueueQqHeartBatch(candidate, process); _resetQqHeartBatches();
    startQqHeartBatchRecovery(process, async () => ready);
    await vi.advanceTimersByTimeAsync(5000); expect(process).not.toHaveBeenCalled();
    expect(getInboxEntry(entryId(candidate))?.state).toBe('pending');
    ready = true; await vi.advanceTimersByTimeAsync(1001); expect(process).toHaveBeenCalledOnce();
  });
  it('does not merge historical twenty-minute gaps into one new burst on recovery', async () => {
    const first = item(1); vi.setSystemTime(Date.now() + 20 * 60_000); const second = item(2);
    for (const candidate of [first, second]) acceptInbox({ lane: 'qq_heart', chatId: candidate.chatId,
      identity: { ...candidate.formatted.eventIdentity!, eventId: entryId(candidate) }, payload: candidate });
    const process = vi.fn(async (_items: QqHeartCandidate[], _signal: AbortSignal) => {});
    startQqHeartBatchRecovery(process); await vi.advanceTimersByTimeAsync(5000);
    expect(process.mock.calls.map(call => call[0].map(candidate => candidate.formatted.messageId)))
      .toEqual([[first.formatted.messageId], [second.formatted.messageId]]);
  });
  it('rechecks recall and current account/allowlist on recovered candidates', async () => {
    const candidate = item(1); const process = vi.fn(async () => {});
    enqueueQqHeartBatch(candidate, process); _resetQqHeartBatches(); f.config.ONEBOT_ALLOWED_GROUP_IDS = '777';
    startQqHeartBatchRecovery(process); await vi.advanceTimersByTimeAsync(2000);
    expect(getInboxEntry(entryId(candidate))?.state).toBe('held'); expect(process).not.toHaveBeenCalled();
    f.config.ONEBOT_ALLOWED_GROUP_IDS = ''; const recalled = item(2); enqueueQqHeartBatch(recalled, process);
    f.recalled.mockReturnValue(true); await vi.advanceTimersByTimeAsync(1500);
    expect(getInboxEntry(entryId(recalled))?.state).toBe('settled'); expect(process).not.toHaveBeenCalled();
  });
  it('keeps overflow candidates pending and shutdown joins the in-flight abort', async () => {
    const process = vi.fn(async (_items: QqHeartCandidate[], signal: AbortSignal) => {
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
    });
    const inputs = Array.from({ length: 33 }, (_, i) => item(i + 1));
    inputs.forEach(candidate => expect(enqueueQqHeartBatch(candidate, process)).toBe(true));
    expect(listPendingInbox('qq_heart')).toHaveLength(33);
    await vi.advanceTimersByTimeAsync(1500); expect(process).toHaveBeenCalledOnce();
    closeQqHeartBatches(); await drainQqHeartBatches();
    expect(getInboxEntry(entryId(inputs[0]!))?.state).toBe('unknown');
    expect(getInboxEntry(entryId(inputs[32]!))?.state).toBe('pending');
  });
});
