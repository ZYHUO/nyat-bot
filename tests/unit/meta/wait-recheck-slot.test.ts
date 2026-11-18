import Database from 'better-sqlite3';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TelegramHeartCandidate } from '../../../src/meta/telegram-heart-store.js';
import type { WaitRecheckControl } from '../../../src/meta/wait-recheck-slot.js';
const f = vi.hoisted(() => ({ db: undefined as unknown as Database.Database, enabled: true, concurrency: 8, metric: vi.fn() }));
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => f.db }));
vi.mock('../../../src/env.js', () => ({ env: () => ({ QUEUE_CONCURRENCY: f.concurrency }) }));
vi.mock('../../../src/meta/flags.js', () => ({ isTelegramHeartBatchChat: () => f.enabled }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn() } }));
vi.mock('../../../src/metrics/registry.js', () => ({ incrCounter: f.metric }));
import { withWaitRecheckSlot as waitForSlot } from '../../../src/meta/wait-recheck-slot.js';
import { acceptTelegramHeartCandidate, checkTelegramHeartClaim, claimTelegramHeartBatch, claimTelegramHeartRecheck, finishTelegramHeartBatch,
  interruptTelegramHeartScope, renewTelegramHeartClaimOwnership, telegramHeartScope } from '../../../src/meta/telegram-heart-store.js';
import { createMessageEventIdentity } from '../../../src/shared/event-identity.js';
function item(id: number, threadId = 0, chatId = -42): TelegramHeartCandidate {
  return { chatId, layer: 'L1', addressed: false, formatted: { role: 'user', uid: 5, username: '', fullName: 'Fixture',
    messageId: id, messageThreadId: threadId || undefined, timestamp: Date.now() / 1000, textContent: 'synthetic', isForwarded: false,
    eventIdentity: createMessageEventIdentity({ ref: { conversation: { platform: 'telegram', accountId: '123', conversationKind: 'group',
      idNamespace: 'telegram', id: String(chatId), ...(threadId ? { threadId: String(threadId) } : {}) }, id: String(id) }, occurredAt: Date.now() }) } };
}
const withWaitRecheckSlot = (source: TelegramHeartCandidate, work: Parameters<typeof waitForSlot>[1], current = async () => true) =>
  waitForSlot(source, work, current);
const pendingEntry = (id: number, threadId: number, chatId = -42) => acceptTelegramHeartCandidate(item(id, threadId, chatId))!;
const reservations = () => f.db.prepare('SELECT chat_key FROM telegram_heart_wait_reservations').all().length;
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
const owner = () => (f.db.prepare('SELECT owner FROM telegram_heart_claims').get() as { owner: string | null } | undefined)?.owner;
async function settle() { await vi.dynamicImportSettled(); for (let n = 0; n < 10; n++) await Promise.resolve(); }
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(100_000); f.enabled = true; f.concurrency = 8; f.metric.mockClear();
  f.db = new Database(':memory:'); f.db.exec(readFileSync('migrations/0134_telegram_heart_batches.sql', 'utf8'));
  f.db.exec(readFileSync('migrations/0135_telegram_heart_source_wait.sql', 'utf8'));
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); f.db.close(); });
describe('Meta WAIT shares the real Telegram Heart chat claim', () => {
  it('leaves unconfigured groups on the existing path without a slot', async () => {
    f.enabled = false; const work = vi.fn(async () => {});
    await withWaitRecheckSlot(item(1), work); expect(work).toHaveBeenCalledWith(); expect(owner()).toBeUndefined();
  });
  it('hands a valid WAIT in B exactly one review after a long active A even with C ready', async () => {
    const active = claimTelegramHeartBatch([pendingEntry(1, 7)])!;
    const reviewing = deferred();
    const work = vi.fn(async (control?: WaitRecheckControl) => { expect(await control!.isCurrent()).toBe(true); await reviewing.promise; });
    const wait = withWaitRecheckSlot(item(2, 8), work); await settle();
    const next = pendingEntry(3, 9);
    await vi.advanceTimersByTimeAsync(3_500);
    expect(work).not.toHaveBeenCalled(); expect(owner()).toBe(active.owner);
    finishTelegramHeartBatch(active, 'settled'); expect(claimTelegramHeartBatch([next])).toBeNull();
    await vi.advanceTimersByTimeAsync(500);
    expect(work).toHaveBeenCalledOnce(); expect(claimTelegramHeartBatch([next])).toBeNull();
    reviewing.resolve(); await wait;
    expect(reservations()).toBe(0); expect(claimTelegramHeartBatch([next])).not.toBeNull();
    expect(f.metric).toHaveBeenCalledWith('meta_wait_recheck_handoffs_total', {});
  });
  it('gives pending fresh input from the same topic priority without starting another model', async () => {
    acceptTelegramHeartCandidate(item(2)); const work = vi.fn(async () => {});
    const pending = withWaitRecheckSlot(item(1), work); await settle(); await vi.advanceTimersByTimeAsync(201); await pending;
    expect(work).not.toHaveBeenCalled();
  });
  it('lets ready fresh input take one turn when WAIT arrives at an idle chat, then takes the next turn', async () => {
    const first = pendingEntry(1, 7); const work = vi.fn(async () => {});
    const wait = withWaitRecheckSlot(item(2, 8), work); await settle();
    const active = claimTelegramHeartBatch([first])!; expect(active).not.toBeNull();
    const next = pendingEntry(3, 9); finishTelegramHeartBatch(active, 'settled');
    expect(claimTelegramHeartBatch([next])).toBeNull();
    await vi.advanceTimersByTimeAsync(1_000); await wait;
    expect(work).toHaveBeenCalledOnce(); expect(claimTelegramHeartBatch([next])).not.toBeNull();
  });
  it.each(['generation', 'new_event', 'direct', 'rollout'])('releases a queued WAIT on %s without model work or effects', async reason => {
    const active = claimTelegramHeartBatch([pendingEntry(1, 7)])!;
    const source = item(2, 8), work = vi.fn(async () => {}); let live = true;
    const wait = withWaitRecheckSlot(source, work, async () => live); await settle();
    expect(reservations()).toBe(1);
    if (reason === 'generation') live = false;
    if (reason === 'new_event') pendingEntry(4, 8);
    if (reason === 'direct') interruptTelegramHeartScope(telegramHeartScope(source));
    if (reason === 'rollout') f.enabled = false;
    finishTelegramHeartBatch(active, 'settled');
    await vi.advanceTimersByTimeAsync(1_000); await wait;
    expect(work).not.toHaveBeenCalled(); expect(reservations()).toBe(0);
    expect(claimTelegramHeartBatch([pendingEntry(3, 9)])).not.toBeNull();
    expect(f.metric).toHaveBeenCalledWith('meta_wait_recheck_yield_total', { reason: 'obsolete' });
  });
  it('recovers a vanished evaluator after its lease expires and fences the old owner', async () => {
    const old = claimTelegramHeartBatch([pendingEntry(1, 7)])!;
    const work = vi.fn(async () => {}); const wait = withWaitRecheckSlot(item(2, 8), work);
    await settle(); await vi.advanceTimersByTimeAsync(89_999);
    expect(work).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); await wait; expect(work).toHaveBeenCalledOnce();
    expect(checkTelegramHeartClaim(old, true)).toBe(false);
  });
  it('expels an abandoned reservation without requiring the WAIT worker to return', async () => {
    const active = claimTelegramHeartBatch([pendingEntry(1, 7)])!;
    const ticket = { scope: telegramHeartScope(item(2, 8)), token: 'vanished-worker' };
    expect(claimTelegramHeartRecheck(ticket, false).status).toBe('reserved');
    const next = pendingEntry(3, 9); finishTelegramHeartBatch(active, 'settled');
    expect(claimTelegramHeartBatch([next])).toBeNull();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(claimTelegramHeartBatch([next])).not.toBeNull();
    expect(claimTelegramHeartRecheck(ticket, true).status).toBe('obsolete');
  });
  it('observes a concurrently committed handoff on a second writer connection in WAL mode', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'telegram-heart-handoff-'));
    const previous = f.db; const file = join(dir, 'authority.sqlite');
    const db = new Database(file); let peer: Worker | undefined;
    try {
      f.db = db; db.pragma('journal_mode=WAL'); db.pragma('busy_timeout=3000');
      db.exec(readFileSync('migrations/0134_telegram_heart_batches.sql', 'utf8'));
      db.exec(readFileSync('migrations/0135_telegram_heart_source_wait.sql', 'utf8'));
      const active = claimTelegramHeartBatch([pendingEntry(1, 7)])!;
      const source = item(2, 8); const ticket = { scope: telegramHeartScope(source), token: 'waiting-worker' };
      const next = pendingEntry(3, 9);
      // A separate OS thread owns the write lock while returning the active
      // seat and publishing B's reservation. C must read the committed state.
      peer = new Worker(`
        const { workerData, parentPort } = require('node:worker_threads');
        const db = new (require('better-sqlite3'))(workerData.file);
        db.exec('BEGIN IMMEDIATE');
        db.prepare('UPDATE telegram_heart_claims SET owner=NULL,lease_until_ms=0 WHERE chat_key=?').run(workerData.chat);
        db.prepare("UPDATE telegram_heart_candidates SET state='settled',owner=NULL,payload_json='{}' WHERE owner=?").run(workerData.active);
        db.prepare('INSERT INTO telegram_heart_wait_reservations VALUES(?,?,?,?,0)')
          .run(workerData.chat, workerData.scope, workerData.token, workerData.until);
        parentPort.postMessage('locked');
        setTimeout(() => { db.exec('COMMIT'); db.close(); }, 100);
      `, { eval: true, workerData: { file, chat: ticket.scope.chatKey, scope: ticket.scope.key,
        token: ticket.token, until: Date.now() + 5_000, active: active.owner } });
      const exited = once(peer, 'exit');
      expect(await once(peer, 'message')).toEqual(['locked']);
      expect(claimTelegramHeartBatch([next])).toBeNull();
      expect(await exited).toEqual([0]);
      const handoff = claimTelegramHeartRecheck(ticket, true);
      if (handoff.status !== 'claimed') throw Error('expected WAIT to own the returned seat');
      expect(checkTelegramHeartClaim(active, true)).toBe(false);
      finishTelegramHeartBatch(handoff.claim, 'settled');
      expect(claimTelegramHeartBatch([next])).not.toBeNull();
    } finally {
      if (peer) await peer.terminate();
      f.db = previous; db.close(); rmSync(dir, { recursive: true, force: true });
    }
  });
  it('expires a live reservation at its fixed deadline without repeated model calls', async () => {
    const active = claimTelegramHeartBatch([pendingEntry(1, 7)])!;
    const work = vi.fn(async () => {}); const wait = withWaitRecheckSlot(item(2, 8), work);
    await settle(); await vi.advanceTimersByTimeAsync(60_000); expect(renewTelegramHeartClaimOwnership(active)).toBe(true);
    await vi.advanceTimersByTimeAsync(40_000); await wait;
    expect(work).not.toHaveBeenCalled(); expect(reservations()).toBe(0); expect(owner()).toBe(active.owner);
    expect(f.metric).toHaveBeenCalledWith('meta_wait_recheck_yield_total', { reason: 'handoff_deadline' });
    finishTelegramHeartBatch(active, 'settled'); expect(claimTelegramHeartBatch([pendingEntry(3, 9)])).not.toBeNull();
  });
  it('reserves the last global model slot for a ready WAIT even under cross-chat pressure', async () => {
    const active = [-1, -2, -3, -4].map(chat => claimTelegramHeartBatch([pendingEntry(1, 7, chat)])!);
    const excess = pendingEntry(1, 7, -5);
    expect(claimTelegramHeartBatch([excess])).toBeNull();
    const work = vi.fn(async () => {}); const wait = withWaitRecheckSlot(item(2, 8, -6), work); await settle();
    finishTelegramHeartBatch(active[0]!, 'settled'); expect(claimTelegramHeartBatch([excess])).toBeNull();
    await vi.advanceTimersByTimeAsync(1_000); await wait;
    expect(work).toHaveBeenCalledOnce(); expect(claimTelegramHeartBatch([excess])).not.toBeNull();
  });
  it('protects the worker and the shared authority from excess WAIT jobs', async () => {
    // Simulate two other workers on the same SQLite authority.
    for (const chat of [-1, -2]) {
      expect(claimTelegramHeartRecheck({ scope: telegramHeartScope(item(1, 7, chat)), token: String(chat) }, false).status).toBe('claimed');
    }
    const work = vi.fn(async () => {});
    await withWaitRecheckSlot(item(2, 8), work);
    expect(work).not.toHaveBeenCalled(); expect(reservations()).toBe(0);
    expect(f.metric).toHaveBeenCalledWith('meta_wait_recheck_yield_total', { reason: 'capacity' });
    expect(claimTelegramHeartBatch([pendingEntry(3, 9)])).not.toBeNull();
  });
  it.each([1, 2, 8])('keeps ordinary queue work moving at worker concurrency %i', async concurrency => {
    f.concurrency = concurrency;
    const active = claimTelegramHeartBatch([pendingEntry(1, 7)])!;
    const work = vi.fn(async () => {}); let live = true;
    const count = concurrency === 8 ? 2 : 1;
    const waits = Array.from({ length: count }, (_, i) => {
      const chat = -42 - i; if (i) claimTelegramHeartBatch([pendingEntry(1, 7, chat)]);
      return withWaitRecheckSlot(item(2, 8, chat), work, async () => live);
    });
    await settle();
    if (concurrency > 1) await withWaitRecheckSlot(item(3, 9, -99), work);
    expect(reservations()).toBe(concurrency === 1 ? 0 : count);
    expect(work).not.toHaveBeenCalled();
    expect(f.metric).toHaveBeenCalledWith('meta_wait_recheck_yield_total', { reason: 'worker_capacity' });
    live = false; await vi.advanceTimersByTimeAsync(1_000); await Promise.all(waits);
    finishTelegramHeartBatch(active, 'settled');
  });
  it('does not overlap a fresh call when new input aborts an uncooperative WAIT model', async () => {
    const model = deferred(); let control: WaitRecheckControl | undefined;
    const wait = withWaitRecheckSlot(item(1), async value => { control = value; await model.promise; });
    await settle(); expect(control).toBeDefined(); const heldOwner = owner();
    const entry = acceptTelegramHeartCandidate(item(2))!;
    expect(claimTelegramHeartBatch([entry])).toBeNull();
    await vi.advanceTimersByTimeAsync(2_001); expect(control!.signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(95_000);
    expect(owner()).toBe(heldOwner); expect(claimTelegramHeartBatch([entry])).toBeNull();
    model.resolve(); await wait; expect(owner()).toBeNull();
    const fresh = claimTelegramHeartBatch([entry]); expect(fresh).not.toBeNull();
    finishTelegramHeartBatch(fresh!, 'settled');
  });
  it('timeout requests abort but releases only after the physical call finishes', async () => {
    const model = deferred(); let control: WaitRecheckControl | undefined;
    const wait = withWaitRecheckSlot(item(1), async value => { control = value; await model.promise; });
    await settle(); const heldOwner = owner(); await vi.advanceTimersByTimeAsync(45_001);
    expect(control!.signal.aborted).toBe(true); expect(owner()).toBe(heldOwner);
    model.resolve(); await wait; expect(owner()).toBeNull();
  });
  it('other topics share the physical slot without invalidating its source', async () => {
    const model = deferred(); let control: WaitRecheckControl | undefined;
    const wait = withWaitRecheckSlot(item(1, 9), async value => { control = value; await model.promise; });
    await settle(); const entry = acceptTelegramHeartCandidate(item(2, 10))!;
    expect(await control!.isCurrent()).toBe(true); expect(claimTelegramHeartBatch([entry])).toBeNull();
    model.resolve(); await wait;
    const fresh = claimTelegramHeartBatch([entry]); expect(fresh).not.toBeNull(); finishTelegramHeartBatch(fresh!, 'settled');
  });
  it('checks effect ownership and releases a failed pure evaluation', async () => {
    await expect(withWaitRecheckSlot(item(1), async control => {
      expect(await control!.beginEffects()).toBe(true); throw Error('synthetic_model_failure');
    })).rejects.toThrow('synthetic_model_failure');
    expect(owner()).toBeNull();
  });
});
