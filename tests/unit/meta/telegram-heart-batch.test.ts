import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ db: undefined as unknown as Database.Database, account: '123', enabled: true }));
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => f.db }));
vi.mock('../../../src/env.js', () => ({ env: () => ({ META_TG_GROUP_COALESCE_MS: 100, META_TG_GROUP_COALESCE_MAX_MS: 300,
  TIMING_GATE_ENABLED: true, META_SUBAGENT_ENABLED: true, CODEACT_ISOLATION_ENABLED: true, META_ACTIVATED_AT_SEC: 1 }) }));
vi.mock('../../../src/pipeline/timing/chat-runtime.js', () => ({ getChatState: async () => ({ state: 'RUNNING' }) }));
vi.mock('../../../src/meta/flags.js', () => ({ isTelegramHeartBatchChat: () => f.enabled }));
vi.mock('../../../src/shared/privacy-scope.js', () => ({ resolveConversationScope: (chatId: number) => ({
  chatId, accountId: f.account, platform: 'telegram', conversationKind: chatId < 0 ? 'group' : 'private',
}) }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn() } }));
import { captureTelegramHeartWaitFence, isTelegramHeartWaitFenceCurrent } from '../../../src/meta/telegram-heart-wait-fence.js';
import { TelegramHeartBatcher } from '../../../src/meta/telegram-heart-batch.js';
import type { TelegramHeartBatchProcess, TelegramHeartBatchControl, TelegramHeartCandidate } from '../../../src/meta/telegram-heart-batch.js';
import { acceptTelegramHeartCandidate, checkTelegramHeartClaim, claimTelegramHeartBatch, deferTelegramHeartSources, finishTelegramHeartBatch,
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
  f.db.exec(readFileSync('migrations/0135_telegram_heart_source_wait.sql', 'utf8'));
});
afterEach(async () => {
  await Promise.all(instances.splice(0).map(value => value.drain()));
  vi.clearAllTimers(); vi.useRealTimers(); f.db.close();
});

describe('Telegram pre-Heart scheduling with the real SQLite store', () => {
  it('retains independent deadlines over restart and merges only an eligible early supplement or quote', async () => {
    const first = batcher();
    const process = vi.fn<TelegramHeartBatchProcess>(async (items, _signal, guard) => {
      switch (ids(items).join(',')) {
        case '1,2':
          expect(guard.defer!([1], 3)).toBe(true);
          expect(guard.defer!([2], 5)).toBe(true);
          break;
        case '1,3': expect(guard.defer!([1], 30)).toBe(true); break;
        case '2,5': break; // A participant's explicit answer closes B's question.
        case '1': expect(guard.defer!([1], 30)).toBe(false); break; // expired
      }
    });
    const a = item(1), b = item(2, -1, 0, 20);
    first.enqueue(a, process); first.enqueue(b, process);
    await vi.advanceTimersByTimeAsync(100); const firstDue = Date.now() + 3000;
    expect(getTelegramHeartEntry(eventId(a))?.item?.waitUntilMs).toBe(firstDue);
    expect(getTelegramHeartEntry(eventId(b))?.item?.waitUntilMs).toBe(firstDue + 2000);
    await first.drain();
    const resumed = batcher(); resumed.recover(process);
    resumed.enqueue(item(3), process); await vi.advanceTimersByTimeAsync(100);
    expect(getTelegramHeartEntry(eventId(a))?.item?.waitUntilMs).toBe(firstDue);
    resumed.enqueue(item(4), process); await vi.advanceTimersByTimeAsync(100);
    const quote = item(5, -1, 0, 30);
    quote.formatted.replyTo = { messageId: 2, uid: 20, fullName: 'B', textSnippet: 'fixture 2' };
    resumed.enqueue(quote, process); await vi.advanceTimersByTimeAsync(100);
    expect(state(b)).toBe('settled'); expect(state(a)).toBe('pending');
    await vi.advanceTimersByTimeAsync(firstDue - Date.now() - 1);
    expect(process.mock.calls.map(call => ids(call[0]))).toEqual([[1, 2], [1, 3], [4], [2, 5]]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(process.mock.calls.map(call => ids(call[0]))).toEqual([[1, 2], [1, 3], [4], [2, 5], [1]]);
    expect(state(a)).toBe('settled');
  });

  it('fires the second deadline after the first without relying on a periodic recovery scan', async () => {
    const queue = batcher();
    const process = vi.fn<TelegramHeartBatchProcess>(async (items, _signal, control) => {
      if (items.length === 2) { control.defer!([1], 2); control.defer!([2], 3); }
    });
    queue.enqueue(item(1), process); queue.enqueue(item(2, -1, 0, 20), process);
    await vi.advanceTimersByTimeAsync(2100);
    expect(process.mock.calls.map(call => ids(call[0]))).toEqual([[1, 2], [1]]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(process.mock.calls.map(call => ids(call[0]))).toEqual([[1, 2], [1], [2]]);
  });

  it('uses authenticated store deadlines, atomically checks every requested id, and rejects a late deferral', () => {
    const source = item(1), reply = item(2);
    source.waitUntilMs = 1; // A caller cannot fabricate a previously reviewed source.
    const a = acceptTelegramHeartCandidate(source)!, b = acceptTelegramHeartCandidate(reply)!;
    expect(a.item?.waitUntilMs).toBeUndefined();
    const claim = claimTelegramHeartBatch([a, b])!;
    expect(claim.scopeVersion).toBe(2);
    expect(deferTelegramHeartSources(claim, [1, 99], 2)).toBe(false);
    expect(state(source)).toBe('evaluating');
    expect(deferTelegramHeartSources(claim, [1, 1], 2)).toBe(false);
    expect(checkTelegramHeartClaim(claim, true)).toBe(true);
    expect(deferTelegramHeartSources(claim, [1], 2)).toBe(false);
    finishTelegramHeartBatch(claim, 'failed');
    expect(state(source)).toBe('unknown'); expect(state(reply)).toBe('unknown');
    expect(deferTelegramHeartSources(claim, [1], 2)).toBe(false);
  });

  it('upgrades unprocessed 0134 rows with a valid generation and recovers a WAIT left by a vanished owner', () => {
    f.db.close(); f.db = new Database(':memory:');
    f.db.exec(readFileSync('migrations/0134_telegram_heart_batches.sql', 'utf8'));
    const candidate = item(99, -2, 4), scope = telegramHeartScope(candidate);
    f.db.prepare(`INSERT INTO telegram_heart_candidates(event_id,scope_key,chat_key,chat_id,account_id,thread_id,received_at_ms,payload_json)
      VALUES(?,?,?,?,?,?,?,?)`).run(eventId(candidate), scope.key, scope.chatKey, scope.chatId, scope.accountId, scope.threadId, Date.now(), JSON.stringify(candidate));
    f.db.exec(readFileSync('migrations/0135_telegram_heart_source_wait.sql', 'utf8'));
    const old = listPendingTelegramHeart()[0]!;
    const claim = claimTelegramHeartBatch([old])!;
    expect(claim.scopeVersion).toBeGreaterThan(0);
    expect(deferTelegramHeartSources(claim, [99], 5)).toBe(true);
    const dueAt = Date.now() + 5000;
    vi.setSystemTime(Date.now() + 90_001);
    // The previous process died after persisting WAIT, before closing its claim.
    expect(listPendingTelegramHeart()[0]?.item?.waitUntilMs).toBe(dueAt);
    expect(checkTelegramHeartClaim(claim, true)).toBe(false);
    expect(acceptTelegramHeartCandidate(candidate)?.item?.waitUntilMs).toBe(dueAt);
    const foreign = acceptTelegramHeartCandidate(item(100, -2, 5))!; // another topic
    expect(claimTelegramHeartBatch([old], true)).toBeNull(); // first ready fresh turn
    const other = claimTelegramHeartBatch([foreign])!; finishTelegramHeartBatch(other, 'settled');
    const due = claimTelegramHeartBatch([old], true)!;
    expect(due.scopeVersion).toBe(claim.scopeVersion);
    expect(deferTelegramHeartSources(due, [99], 1)).toBe(false);
    interruptTelegramHeartScope(scope);
    expect(checkTelegramHeartClaim(due, true)).toBe(false);
    finishTelegramHeartBatch(due, 'aborted');
    const next = claimTelegramHeartBatch([old], true)!;
    expect(next.scopeVersion).toBe(due.scopeVersion + 1);
  });

  it('preserves an independent fresh WAIT if an older selected source expires just before the write', () => {
    const source = acceptTelegramHeartCandidate(item(1))!;
    const first = claimTelegramHeartBatch([source])!;
    expect(deferTelegramHeartSources(first, [1], 2)).toBe(true);
    finishTelegramHeartBatch(first, 'settled');
    vi.setSystemTime(Date.now() + 1900);
    const fresh = acceptTelegramHeartCandidate(item(2))!;
    const mixed = claimTelegramHeartBatch([fresh])!;
    expect(ids(mixed.entries.map(entry => entry.item!))).toEqual([1, 2]);
    vi.setSystemTime(Date.now() + 100);
    expect(deferTelegramHeartSources(mixed, [1, 2], 5)).toBe(true);
    finishTelegramHeartBatch(mixed, 'settled');
    expect(state(source.item!)).toBe('settled');
    expect(getTelegramHeartEntry(fresh.eventId)?.item?.waitUntilMs).toBe(Date.now() + 5000);
  });

  it('admits fresh work despite many idle WAIT scopes and restores the nearest due timer first', async () => {
    for (let i = 1; i <= 65; i++) {
      const entry = acceptTelegramHeartCandidate(item(i, -i))!;
      const first = claimTelegramHeartBatch([entry])!;
      expect(deferTelegramHeartSources(first, [i], i === 65 ? 1 : 120)).toBe(true);
      finishTelegramHeartBatch(first, 'settled');
    }
    const queue = batcher(), process = vi.fn<TelegramHeartBatchProcess>(async () => {});
    queue.recover(process); queue.recover(process);
    queue.enqueue(item(80, -80), process);
    await vi.advanceTimersByTimeAsync(1000);
    expect(process.mock.calls.map(call => ids(call[0]))).toEqual([[80], [65]]);
  });

  it('fences a due review when an unrelated speaker writes in-flight, then recovers the due source', async () => {
    const queue = batcher();
    const process = vi.fn<TelegramHeartBatchProcess>(async (items, signal, control) => {
      if (process.mock.calls.length === 1) { expect(control.defer!([2], 1)).toBe(true); return; }
      if (process.mock.calls.length === 2) {
        await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
        expect(await control.beginEffects()).toBe(false);
        expect(control.defer!([2], 10)).toBe(false);
      }
      if (process.mock.calls.length === 3) {
        expect(ids(items)).toEqual([2,3]); // new evidence and the original due source
        expect(await control.beginEffects()).toBe(true);
      }
    });
    const source = item(2, -1, 9, 20);
    queue.enqueue(source, process); await vi.advanceTimersByTimeAsync(1100);
    expect(process).toHaveBeenCalledTimes(2);
    queue.enqueue(item(3, -1, 9, 30), process);
    await vi.advanceTimersByTimeAsync(1500);
    expect(process).toHaveBeenCalledTimes(3); expect(state(source)).toBe('settled');
  });

  it('shares the WAIT class budget with transport timers and leaves space for fresh work', () => {
    const delayed = [-1, -2, -3].map(chat => {
      const entry = acceptTelegramHeartCandidate(item(1, chat))!;
      const owner = claimTelegramHeartBatch([entry])!;
      expect(deferTelegramHeartSources(owner, [1], 1)).toBe(true);
      finishTelegramHeartBatch(owner, 'settled'); return entry;
    });
    vi.setSystemTime(Date.now() + 1000);
    const wake = claimTelegramHeartRecheck({ scope: telegramHeartScope(item(9, -9)), token: 'legacy' }, false);
    expect(wake.status).toBe('claimed');
    const first = claimTelegramHeartBatch([delayed[0]!], true)!;
    expect(first.entries).toHaveLength(1);
    expect(claimTelegramHeartBatch([delayed[1]!], true)).toBeNull();
    expect(claimTelegramHeartBatch([acceptTelegramHeartCandidate(item(7, -7))!])).not.toBeNull();
    finishTelegramHeartBatch(first, 'settled');
    expect(claimTelegramHeartBatch([delayed[1]!], true)).not.toBeNull();
  });

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
    const approval = captureTelegramHeartWaitFence(-1, 0, 128)!;
    // A known retransmission cannot revoke this approval, even at capacity.
    expect(queue.enqueue(item(128), process)).toBe(true);
    expect(await isTelegramHeartWaitFenceCurrent(approval)).toBe(true);
    const rejected = item(129);
    expect(queue.enqueue(rejected, process)).toBe(false);
    expect(await isTelegramHeartWaitFenceCurrent(approval)).toBe(false);
    expect(getTelegramHeartEntry(eventId(rejected))).toBeNull();
    expect(process).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100); expect(process.mock.calls[0]![0]).toHaveLength(32);
    expect(listPendingTelegramHeart(0, 256)).toHaveLength(96);
    for (let page = 0; page < 8; page++) { queue.recover(process); await vi.advanceTimersByTimeAsync(1); }
    expect(process.mock.calls.flatMap(call => ids(call[0]))).toHaveLength(128);
    expect(new Set(process.mock.calls.flatMap(call => ids(call[0]))).size).toBe(128);
  });

  it('creates no scope or model work for a previously unseen topic during global overload', () => {
    // 32 synthetic scopes at 128 rows each; this path only reads row counts.
    f.db.exec(`WITH RECURSIVE n(id) AS (VALUES(0) UNION ALL SELECT id+1 FROM n WHERE id<4095)
      INSERT INTO telegram_heart_candidates(event_id,scope_key,chat_key,chat_id,account_id,thread_id,received_at_ms,payload_json)
      SELECT 'fixture-'||id, 'scope-'||(id%32), 'fixture-chat', -1,'123',id%32,100000,'{}' FROM n`);
    const queue = batcher(), process = vi.fn<TelegramHeartBatchProcess>(async () => {});
    expect(queue.enqueue(item(42, -99), process)).toBe(false);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM telegram_heart_scope_versions').get()).toEqual({ n: 0 });
    expect(process).not.toHaveBeenCalled();
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
