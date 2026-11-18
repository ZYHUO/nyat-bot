import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ db: undefined as unknown as Database.Database, account: '123', enabled: true }));
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => f.db }));
vi.mock('../../../src/env.js', () => ({ env: () => ({ META_TG_GROUP_COALESCE_MS: 100, META_TG_GROUP_COALESCE_MAX_MS: 300 }) }));
vi.mock('../../../src/meta/flags.js', () => ({ isTelegramHeartBatchChat: () => f.enabled }));
vi.mock('../../../src/shared/privacy-scope.js', () => ({ resolveConversationScope: (chatId: number) => ({
  chatId, accountId: f.account, platform: 'telegram', conversationKind: chatId < 0 ? 'group' : 'private',
}) }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn() } }));
import { TelegramHeartBatcher } from '../../../src/meta/telegram-heart-batch.js';
import type { TelegramHeartBatchProcess, TelegramHeartBatchControl, TelegramHeartCandidate } from '../../../src/meta/telegram-heart-batch.js';
import { acceptTelegramHeartCandidate, checkTelegramHeartClaim, claimTelegramHeartBatch, finishTelegramHeartBatch,
  claimTelegramHeartRecheck, getTelegramHeartEntry, interruptTelegramHeartScope, listPendingTelegramHeart,
  renewTelegramHeartClaimOwnership, telegramHeartScope } from '../../../src/meta/telegram-heart-store.js';
import { createMessageEventIdentity } from '../../../src/shared/event-identity.js';

const instances: TelegramHeartBatcher[] = [];
function batcher(concurrency = 1, timeoutMs = 1000): TelegramHeartBatcher {
  const value = new TelegramHeartBatcher(() => ({ quietMs: 100, maxMs: 300, concurrency, timeoutMs }));
  instances.push(value); return value;
}
function item(id: number, chatId = -1, threadId = 0, uid = 10): TelegramHeartCandidate {
  return { chatId, layer: 'L2', addressed: false, formatted: { role: 'user', uid, username: '', fullName: 'synthetic',
    timestamp: Date.now() / 1000, messageId: id, messageThreadId: threadId || undefined, textContent: `fixture ${id}`, isForwarded: false,
    eventIdentity: createMessageEventIdentity({ ref: { conversation: { platform: 'telegram', idNamespace: 'telegram',
      accountId: f.account, conversationKind: 'group', id: String(chatId), ...(threadId ? { threadId: String(threadId) } : {}) }, id: String(id) }, occurredAt: Date.now() }) } };
}
const eventId = (value: TelegramHeartCandidate) => value.formatted.eventIdentity!.eventId;
const state = (value: TelegramHeartCandidate) => getTelegramHeartEntry(eventId(value))?.state;
const ids = (values: TelegramHeartCandidate[]) => values.map(value => value.formatted.messageId);
function withIntent(value: TelegramHeartCandidate, revision: number): TelegramHeartCandidate {
  value.formatted.pendingIntent = { laneKey: `lane-${value.formatted.uid}`, intentId: 'intent', revision,
    accountId: f.account, platform: 'telegram', chatId: value.chatId, senderId: value.formatted.uid, threadId: value.formatted.messageThreadId ?? 0 };
  return value;
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(100_000); f.account = '123'; f.enabled = true;
  f.db = new Database(':memory:'); f.db.exec(readFileSync('migrations/0134_telegram_heart_batches.sql', 'utf8'));
});
afterEach(async () => {
  await Promise.all(instances.splice(0).map(value => value.drain()));
  vi.clearAllTimers(); vi.useRealTimers(); f.db.close();
});

describe('Telegram pre-Heart scheduling with the real SQLite store', () => {
  it('bounds passive re-evaluation under repeated direct interruptions', () => {
    const candidate = item(1, -1, 7);
    const entry = acceptTelegramHeartCandidate(candidate)!;
    for (let attempt = 0; attempt < 3; attempt++) {
      const claim = claimTelegramHeartBatch([entry])!;
      interruptTelegramHeartScope(entry.scope);
      expect(checkTelegramHeartClaim(claim, true)).toBe(false);
      finishTelegramHeartBatch(claim, 'aborted');
    }
    expect(state(candidate)).toBe('held');
    expect(claimTelegramHeartBatch([entry])).toBeNull();
    expect(listPendingTelegramHeart()).toHaveLength(0);
  });

  it('holds one chat seat for fresh input and WAIT rechecks even while an aborted call drains', () => {
    const wake = item(1, -1, 7), otherTopic = item(2, -1, 8);
    const ticket = { scope: telegramHeartScope(otherTopic), token: 'worker-2' };
    const first = claimTelegramHeartRecheck({ scope: telegramHeartScope(wake), token: 'worker-1' }, false);
    if (first.status !== 'claimed') throw Error('expected available chat');
    const claim = first.claim;
    expect(checkTelegramHeartClaim(claim)).toBe(true);
    expect(claimTelegramHeartRecheck(ticket, false).status).toBe('reserved');
    const pending = acceptTelegramHeartCandidate(item(3, -1, 7))!;
    expect(checkTelegramHeartClaim(claim, true)).toBe(false);
    vi.setSystemTime(Date.now() + 80_000);
    expect(renewTelegramHeartClaimOwnership(claim)).toBe(true);
    vi.setSystemTime(Date.now() + 20_000);
    expect(claimTelegramHeartBatch([pending])).toBeNull();
    finishTelegramHeartBatch(claim, 'aborted');
    expect(renewTelegramHeartClaimOwnership(claim)).toBe(false);
    // The absent wait worker lost its reservation; a new request gives
    // already-pending fresh work its first turn before taking the seat.
    expect(claimTelegramHeartRecheck(ticket, true).status).toBe('obsolete');
    expect(claimTelegramHeartRecheck(ticket, false).status).toBe('reserved');
    const next = claimTelegramHeartBatch([pending])!;
    expect(checkTelegramHeartClaim(next)).toBe(true);
    expect(checkTelegramHeartClaim(claim)).toBe(false);
  });
  it('coalesces a continuous burst at the original hard deadline and keeps topics separate', async () => {
    const queue = batcher(), process = vi.fn<TelegramHeartBatchProcess>(async () => {});
    queue.enqueue(item(1), process);
    for (let id = 2; id <= 4; id++) { await vi.advanceTimersByTimeAsync(80); queue.enqueue(item(id), process); }
    queue.enqueue(item(50, -1, 7), process);
    await vi.advanceTimersByTimeAsync(59); expect(process).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(ids(process.mock.calls[0]![0])).toEqual([1, 2, 3, 4]);
    await vi.advanceTimersByTimeAsync(40); expect(ids(process.mock.calls[1]![0])).toEqual([50]);
  });

  it('honors a maximum shorter than the quiet window', async () => {
    const queue = new TelegramHeartBatcher(() => ({ quietMs: 500, maxMs: 100, concurrency: 1, timeoutMs: 1000 }));
    instances.push(queue); const process = vi.fn<TelegramHeartBatchProcess>(async () => {});
    queue.enqueue(item(1), process); await vi.advanceTimersByTimeAsync(99); expect(process).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(process).toHaveBeenCalledOnce();
  });

  it('rejects cross-account/topic identity and private/direct candidates before persistence', () => {
    const queue = batcher(), process = vi.fn<TelegramHeartBatchProcess>(async () => {});
    const wrongAccount = item(1); f.account = '456'; expect(queue.enqueue(wrongAccount, process)).toBe(false);
    const wrongTopic = item(2); wrongTopic.formatted.messageThreadId = 7;
    expect(() => queue.enqueue(wrongTopic, process)).toThrow('telegram_heart_scope_invalid');
    expect(() => queue.enqueue(item(3, 9), process)).toThrow('telegram_heart_scope_invalid');
    expect(queue.enqueue({ ...item(4), addressed: true }, process)).toBe(false);
    expect(listPendingTelegramHeart()).toHaveLength(0);
  });

  it('retains the original on pending retransmission and suppresses settled replay after restart', async () => {
    const first = batcher(), candidate = item(1), process = vi.fn<TelegramHeartBatchProcess>(async () => {});
    first.enqueue(candidate, process); first.close();
    const restarted = batcher(); restarted.enqueue({ ...candidate, formatted: { ...candidate.formatted, textContent: 'changed duplicate' } }, process);
    await vi.advanceTimersByTimeAsync(100);
    expect(process.mock.calls[0]![0][0]!.formatted.textContent).toBe('fixture 1'); expect(state(candidate)).toBe('settled');
    restarted.enqueue(candidate, process); restarted.recover(process); await vi.advanceTimersByTimeAsync(1000);
    expect(process).toHaveBeenCalledOnce();
  });

  it('recovers never-started input without merging historical gaps into one burst', async () => {
    const a = item(1); acceptTelegramHeartCandidate(a); vi.setSystemTime(Date.now() + 20 * 60_000);
    const b = item(2); acceptTelegramHeartCandidate(b);
    const queue = batcher(), process = vi.fn<TelegramHeartBatchProcess>(async () => {});
    queue.recover(process); await vi.advanceTimersByTimeAsync(0);
    queue.recover(process); queue.recover(process); await vi.advanceTimersByTimeAsync(100);
    expect(process.mock.calls.map(call => ids(call[0]))).toEqual([[1], [2]]);
  });

  it('rotates ready scopes before the next hot-chat cohort and serializes topics in one chat', async () => {
    const queue = batcher(2), order: number[] = [];
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const process: TelegramHeartBatchProcess = async batch => { order.push(batch[0]!.formatted.messageId); if (order.length <= 2) await blocked; };
    queue.enqueue(item(1, -1), process); queue.enqueue(item(2, -2), process);
    await vi.advanceTimersByTimeAsync(100); expect(order).toEqual([1, 2]);
    queue.enqueue(item(3, -3), process); queue.enqueue(item(4, -1, 7), process);
    queue.enqueue(item(5, -1), process);
    await vi.advanceTimersByTimeAsync(100); expect(order).toEqual([1, 2]);
    release(); await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual([1, 2, 3, 4, 5]);
  });

  it('does not abort independent authors or topics during an in-flight evaluation', async () => {
    const queue = batcher(); let signal!: AbortSignal; let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const process = vi.fn<TelegramHeartBatchProcess>(async (_items, current) => { signal = current; await blocked; });
    queue.enqueue(withIntent(item(1), 1), process); await vi.advanceTimersByTimeAsync(100);
    queue.enqueue(withIntent(item(2, -1, 0, 20), 1), process); queue.enqueue(withIntent(item(3, -1, 7), 2), process);
    expect(signal.aborted).toBe(false); release(); await vi.advanceTimersByTimeAsync(100);
    expect(process).toHaveBeenCalledTimes(3);
  });

  it('cancels a related stale revision but carries independent batch candidates into reconsideration', async () => {
    const queue = batcher(); let control!: TelegramHeartBatchControl; let signal!: AbortSignal;
    const process = vi.fn<TelegramHeartBatchProcess>(async (_items, current, guard) => {
      if (process.mock.calls.length === 1) { control = guard; signal = current; await new Promise<void>(resolve => current.addEventListener('abort', () => resolve(), { once: true })); }
    });
    queue.enqueue(withIntent(item(1), 1), process); queue.enqueue(withIntent(item(2, -1, 0, 20), 1), process);
    await vi.advanceTimersByTimeAsync(100);
    queue.enqueue(withIntent(item(3), 2), process);
    expect(signal.aborted).toBe(true); expect(await control.beginEffects()).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(process.mock.calls.slice(1).map(call => ids(call[0]))).toEqual([[1], [2], [3]]);
    // The independent author now has its own cohort instead of sharing every
    // cancellation and retry budget with the continuously revised speaker.
    expect(process.mock.calls.slice(1).every(call => new Set(call[0].map(entry => entry.formatted.uid)).size === 1)).toBe(true);
  });

  it('interrupts only the addressed topic, retains independent inputs and rejects late effects', async () => {
    const queue = batcher(); let control!: TelegramHeartBatchControl;
    const process = vi.fn<TelegramHeartBatchProcess>(async (_items, signal, guard) => {
      if (process.mock.calls.length === 1) { control = guard; await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); }
    });
    const a = item(1, -1, 7), b = item(2, -1, 8);
    queue.enqueue(a, process); await vi.advanceTimersByTimeAsync(100); queue.enqueue(b, process);
    queue.interrupt(-1, 7); expect(await control.isCurrent()).toBe(false); await vi.advanceTimersByTimeAsync(100);
    expect(state(a)).toBe('settled'); expect(state(b)).toBe('settled'); expect(process).toHaveBeenCalledTimes(3);
  });

  it('bounds retries of a timed-out pure evaluation and aborts the actual processor', async () => {
    const queue = batcher(1, 50), candidate = item(1);
    const process = vi.fn<TelegramHeartBatchProcess>(async (_items, signal) => {
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
    });
    queue.enqueue(candidate, process); await vi.advanceTimersByTimeAsync(400);
    expect(process).toHaveBeenCalledTimes(3); expect(state(candidate)).toBe('held');
    expect(process.mock.calls.every(call => call[1].aborted)).toBe(true);
  });

  it('keeps uncertain effects unknown instead of retrying or recounting them as completed', async () => {
    const queue = batcher(), candidate = item(1);
    const process = vi.fn<TelegramHeartBatchProcess>(async (_items, _signal, control) => {
      expect(await control.beginEffects()).toBe(true); throw new Error('transport outcome uncertain');
    });
    queue.enqueue(candidate, process); await vi.advanceTimersByTimeAsync(100);
    expect(state(candidate)).toBe('unknown'); queue.recover(process); await vi.advanceTimersByTimeAsync(1000);
    expect(process).toHaveBeenCalledOnce();
  });

  it('shares the per-chat claim across batcher instances and rejects expired owners', async () => {
    const a = item(1), b = item(2, -1, 7);
    const first = acceptTelegramHeartCandidate(a)!, second = acceptTelegramHeartCandidate(b)!;
    const old = claimTelegramHeartBatch([first])!;
    expect(claimTelegramHeartBatch([second])).toBeNull();
    vi.setSystemTime(Date.now() + 90_001); listPendingTelegramHeart();
    const current = claimTelegramHeartBatch([second])!;
    expect(current.version).toBeGreaterThan(old.version); expect(checkTelegramHeartClaim(old, true)).toBe(false);
    finishTelegramHeartBatch(old, 'settled'); expect(checkTelegramHeartClaim(current)).toBe(true);
    finishTelegramHeartBatch(current, 'settled'); expect(state(a)).toBe('pending'); expect(state(b)).toBe('settled');
  });

  it('runs only one Heart processor per account/chat across two independent scheduling instances', async () => {
    const left = batcher(), right = batcher(); let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const first = vi.fn<TelegramHeartBatchProcess>(async () => { await blocked; });
    const second = vi.fn<TelegramHeartBatchProcess>(async () => {});
    left.enqueue(item(1, -1, 7), first); right.enqueue(item(2, -1, 8), second);
    await vi.advanceTimersByTimeAsync(100); expect(first).toHaveBeenCalledOnce(); expect(second).not.toHaveBeenCalled();
    release(); await vi.advanceTimersByTimeAsync(250); expect(second).toHaveBeenCalledOnce();
  });

  it('recovers expired pure work but never an expired attempt that started effects', () => {
    const pure = item(1), effects = item(2, -2);
    const a = claimTelegramHeartBatch([acceptTelegramHeartCandidate(pure)!])!;
    const b = claimTelegramHeartBatch([acceptTelegramHeartCandidate(effects)!])!;
    expect(checkTelegramHeartClaim(b, true)).toBe(true);
    vi.setSystemTime(Date.now() + 90_001); listPendingTelegramHeart();
    expect(state(pure)).toBe('pending'); expect(state(effects)).toBe('unknown');
    expect(checkTelegramHeartClaim(a, true)).toBe(false); expect(checkTelegramHeartClaim(b, true)).toBe(false);
  });

  it('bounds each batch while overflow remains durably pending and rejects storage overcapacity', async () => {
    const queue = batcher(), process = vi.fn<TelegramHeartBatchProcess>(async () => {});
    for (let id = 1; id <= 128; id++) expect(queue.enqueue(item(id), process)).toBe(true);
    expect(queue.enqueue(item(129), process)).toBe(false);
    await vi.advanceTimersByTimeAsync(100); expect(process.mock.calls[0]![0]).toHaveLength(32);
    expect(listPendingTelegramHeart(0, 256)).toHaveLength(96);
    for (let page = 0; page < 8; page++) { queue.recover(process); await vi.advanceTimersByTimeAsync(1); }
    expect(process.mock.calls.flatMap(call => ids(call[0]))).toHaveLength(128);
    expect(new Set(process.mock.calls.flatMap(call => ids(call[0]))).size).toBe(128);
  });

  it('holds old-account recovery and stops startup recovery from publishing into a new account', () => {
    const candidate = item(1); acceptTelegramHeartCandidate(candidate); f.account = '456';
    const process = vi.fn<TelegramHeartBatchProcess>(async () => {}); batcher().recover(process);
    expect(state(candidate)).toBe('held'); expect(process).not.toHaveBeenCalled();
  });

  it('erases terminal batch-cache bodies while retaining durable deduplication tombstones', async () => {
    const candidate = item(1), queue = batcher(), process = vi.fn<TelegramHeartBatchProcess>(async () => {});
    queue.enqueue(candidate, process); await vi.advanceTimersByTimeAsync(100);
    const row = f.db.prepare('SELECT payload_json,state FROM telegram_heart_candidates WHERE event_id=?').get(eventId(candidate));
    expect(row).toEqual({ payload_json: '{}', state: 'settled' }); expect(getTelegramHeartEntry(eventId(candidate))!.item).toBeNull();
    expect(queue.enqueue(candidate, process)).toBe(true); await vi.advanceTimersByTimeAsync(100);
    expect(process).toHaveBeenCalledOnce();
  });
});
