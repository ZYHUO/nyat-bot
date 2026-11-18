import { env } from '../env.js';
import { logger } from '../shared/logger.js';
import { incrCounter } from '../metrics/registry.js';
import { canonicalJson, eventHash } from '../shared/event-identity.js';
import { resolveConversationScope } from '../shared/privacy-scope.js';
import { isTelegramHeartBatchChat } from './flags.js';
import { acceptTelegramHeartCandidate, checkTelegramHeartClaim, claimTelegramHeartBatch, finishTelegramHeartBatch,
  getTelegramHeartEntry, holdTelegramHeartCandidate, interruptTelegramHeartScope, listPendingTelegramHeart,
  renewTelegramHeartClaimOwnership, telegramHeartScope } from './telegram-heart-store.js';
import type { TelegramHeartCandidate, TelegramHeartClaim, TelegramHeartEntry, TelegramHeartScope } from './telegram-heart-store.js';
export type { TelegramHeartCandidate } from './telegram-heart-store.js';

export interface TelegramHeartBatchControl {
  isCurrent(): Promise<boolean>;
  /** Call before reactions, WAIT publication and Attention ingestion, not before model evaluation. */
  beginEffects(): Promise<boolean>;
}
export type TelegramHeartBatchProcess = (items: TelegramHeartCandidate[], signal: AbortSignal, control: TelegramHeartBatchControl) => Promise<void>;
interface Settings { quietMs: number; maxMs: number; concurrency: number; timeoutMs: number }
interface PendingScope {
  key: string; scope: TelegramHeartScope; entries: TelegramHeartEntry[]; process: TelegramHeartBatchProcess;
  timer?: ReturnType<typeof setTimeout>; ready: boolean;
}
interface Active { scope: TelegramHeartScope; claim: TelegramHeartClaim; controller: AbortController }
const MAX_SCOPES = 64;
const MAX_BATCH = 32;

/** SQLite owns accepted candidates and execution claims. Timers and this ready
 * ring are disposable scheduling hints, never the sole copy of accepted work. */
export class TelegramHeartBatcher {
  private readonly pending = new Map<string, PendingScope>();
  private readonly ready: string[] = [];
  private readonly readySet = new Set<string>();
  private readonly active = new Map<string, Active>();
  private readonly running = new Set<Promise<void>>();
  private closed = false;
  private cursor = 0;
  private retry?: ReturnType<typeof setTimeout>;

  constructor(private readonly settings: () => Settings = () => ({ quietMs: env().META_TG_GROUP_COALESCE_MS,
    maxMs: env().META_TG_GROUP_COALESCE_MAX_MS, concurrency: 4, timeoutMs: 45_000 })) {}

  private currentScope(scope: TelegramHeartScope): boolean {
    const current = resolveConversationScope(scope.chatId);
    return isTelegramHeartBatchChat(scope.chatId) && current?.platform === 'telegram'
      && current.accountId === scope.accountId && current.conversationKind === 'group';
  }

  enqueue(item: TelegramHeartCandidate, process: TelegramHeartBatchProcess): boolean {
    if (this.closed || item.addressed) return false;
    const scope = telegramHeartScope(item);
    if (!this.currentScope(scope)) return false;
    const entry = acceptTelegramHeartCandidate(item);
    if (!entry) {
      logger.warn({ chatId: scope.chatId, reason: 'telegram_heart_capacity' }, 'Telegram Heart candidate not accepted');
      return false;
    }
    const active = this.active.get(scope.chatKey);
    if (active?.scope.key === scope.key && !checkTelegramHeartClaim(active.claim)) active.controller.abort();
    if (entry.state === 'pending') this.load(entry, process);
    return true;
  }

  private due(state: PendingScope): number {
    const times = state.entries.map(entry => entry.item!.formatted.eventIdentity!.receivedAt);
    const { quietMs, maxMs } = this.settings();
    return Math.min(Math.max(...times) + quietMs, Math.min(...times) + maxMs);
  }

  private load(entry: TelegramHeartEntry, process: TelegramHeartBatchProcess): void {
    if (this.closed || !entry.item) return;
    // After a mixed cohort was invalidated, separate its authors. A continuously
    // revised speaker can no longer repeatedly abort the other speakers' work.
    const key = entry.scope.key + (entry.attempts > 0
      ? ':' + eventHash(entry.item.formatted.pendingIntent?.laneKey ?? String(entry.item.formatted.uid)) : '');
    let state = this.pending.get(key);
    if (!state) {
      if (this.pending.size >= MAX_SCOPES) return; // Persisted pending: a later recovery page will revisit it.
      state = { key, scope: entry.scope, entries: [], process, ready: false };
      this.pending.set(key, state);
    }
    if (state.entries.some(old => old.eventId === entry.eventId) || state.entries.length >= MAX_BATCH) return;
    if (state.entries.length && entry.item.formatted.eventIdentity!.receivedAt > this.due(state)) {
      this.makeReady(state); return; // Do not combine separate historical bursts during recovery.
    }
    state.entries.push(entry); state.entries.sort((a, b) => a.sequence - b.sequence); state.process = process;
    if (state.ready) return; // A ready cohort never loses its turn to newer traffic.
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => { state!.timer = undefined; this.makeReady(state!); }, Math.max(0, this.due(state) - Date.now()));
    state.timer.unref?.();
  }

  private makeReady(state: PendingScope): void {
    if (state.timer) clearTimeout(state.timer);
    state.timer = undefined; state.ready = true;
    if (!this.readySet.has(state.key)) { this.readySet.add(state.key); this.ready.push(state.key); }
    this.safePump();
  }

  /** FIFO ready rotation prevents a continuously busy chat from jumping ahead
   * of another ready scope. All topics in one account/chat share one claim. */
  private pump(): void {
    if (this.closed) return;
    const turns = this.ready.length;
    for (let n = 0; n < turns && this.active.size < this.settings().concurrency; n++) {
      const key = this.ready.shift()!; this.readySet.delete(key);
      const state = this.pending.get(key);
      if (!state?.ready) continue;
      if (this.active.has(state.scope.chatKey)) { this.ready.push(key); this.readySet.add(key); continue; }
      // Another process may already have handled a scheduling hint.
      state.entries = state.entries.map(entry => getTelegramHeartEntry(entry.eventId)).filter((entry): entry is TelegramHeartEntry => entry?.state === 'pending');
      if (!state.entries.length) { this.pending.delete(key); continue; }
      if (!this.currentScope(state.scope)) {
        for (const entry of state.entries) holdTelegramHeartCandidate(entry.eventId, 'account_or_rollout_changed');
        this.pending.delete(key); continue;
      }
      const claim = claimTelegramHeartBatch(state.entries);
      if (!claim) {
        this.ready.push(key); this.readySet.add(key);
        if (!this.retry) {
          this.retry = setTimeout(() => { this.retry = undefined; this.safePump(); }, 250); this.retry.unref?.();
        }
        continue;
      }
      this.pending.delete(key);
      const active: Active = { scope: state.scope, claim, controller: new AbortController() };
      this.active.set(state.scope.chatKey, active);
      const work = this.run(state, active);
      this.running.add(work);
      void work.finally(() => { this.running.delete(work); this.safePump(); });
    }
  }

  private safePump(): void {
    try { this.pump(); }
    catch {
      logger.warn('Telegram Heart scheduling storage unavailable; candidates remain durable');
      for (const state of this.pending.values()) {
        if (state.ready && !this.readySet.has(state.key)) { this.readySet.add(state.key); this.ready.push(state.key); }
      }
      if (!this.retry && !this.closed) {
        this.retry = setTimeout(() => { this.retry = undefined; this.safePump(); }, 250); this.retry.unref?.();
      }
    }
  }

  private async run(state: PendingScope, active: Active): Promise<void> {
    const { controller, claim } = active;
    const check = (effects = false): boolean => {
      if (controller.signal.aborted || this.closed) return false;
      try {
        if (this.currentScope(active.scope) && checkTelegramHeartClaim(claim, effects)) return true;
      } catch { /* Unknown ownership never authorizes effects. */ }
      controller.abort(); return false;
    };
    const control: TelegramHeartBatchControl = { isCurrent: async () => check(), beginEffects: async () => check(true) };
    const heartbeat = setInterval(() => {
      try {
        if (!renewTelegramHeartClaimOwnership(claim) || !check()) controller.abort();
      } catch { controller.abort(); }
    }, 10_000); heartbeat.unref?.();
    const timeout = setTimeout(() => controller.abort(), this.settings().timeoutMs); timeout.unref?.();
    let outcome: 'settled' | 'aborted' | 'failed' = 'failed';
    try {
      if (check()) {
        incrCounter('telegram_heart_batches_started_total', {});
        incrCounter('telegram_heart_batch_candidates_total', {}, state.entries.length);
        await state.process(state.entries.map(entry => entry.item!), controller.signal, control);
        outcome = controller.signal.aborted ? 'aborted' : 'settled';
      } else outcome = 'aborted';
    } catch {
      outcome = controller.signal.aborted ? 'aborted' : 'failed';
      logger.warn({ chatId: state.scope.chatId, count: state.entries.length, outcome }, 'Telegram Heart batch stopped');
    } finally {
      incrCounter('telegram_heart_batches_finished_total', { outcome });
      clearInterval(heartbeat); clearTimeout(timeout);
      try { finishTelegramHeartBatch(claim, outcome); }
      catch { logger.warn('Telegram Heart completion storage unavailable; lease recovery owns the result'); }
      this.active.delete(state.scope.chatKey);
      if (!this.closed) {
        // Recovered pure evaluations keep their original intake time and join the ready tail.
        for (const entry of state.entries) {
          try { const fresh = getTelegramHeartEntry(entry.eventId); if (fresh?.state === 'pending') this.load(fresh, state.process); }
          catch { /* The recovery scan can retry after storage returns. */ }
        }
      }
    }
  }

  interrupt(chatId: number, threadId = 0): void {
    const current = resolveConversationScope(chatId);
    if (!current?.accountId || current.platform !== 'telegram' || chatId >= 0
      || !Number.isSafeInteger(threadId) || threadId < 0) return;
    const scope: TelegramHeartScope = { key: eventHash(canonicalJson([current.accountId, chatId, threadId])),
      chatKey: eventHash(canonicalJson([current.accountId, chatId])), chatId, threadId, accountId: current.accountId };
    // Leave not-yet-started candidates queued: an explicit input cannot cancel
    // independent authors. Only the old evaluation's permission is invalidated.
    const active = this.active.get(scope.chatKey);
    if (active?.scope.key === scope.key) active.controller.abort();
    interruptTelegramHeartScope(scope);
  }

  recover(process: TelegramHeartBatchProcess): void {
    if (this.closed) return;
    const page = listPendingTelegramHeart(this.cursor);
    if (!page.length) { this.cursor = 0; return; }
    for (const entry of page) {
      this.cursor = entry.sequence;
      if (!this.currentScope(entry.scope)) { holdTelegramHeartCandidate(entry.eventId, 'account_or_rollout_changed'); continue; }
      this.load(entry, process);
    }
  }
  close(): void {
    this.closed = true;
    if (this.retry) clearTimeout(this.retry);
    for (const state of this.pending.values()) if (state.timer) clearTimeout(state.timer);
    for (const active of this.active.values()) active.controller.abort();
    this.pending.clear(); this.ready.length = 0; this.readySet.clear();
  }
  async drain(): Promise<void> { this.close(); await Promise.all([...this.running]); }
}

let batcher = new TelegramHeartBatcher();
let stopRecovery: (() => Promise<void>) | undefined;
let recoveryDrain: Promise<void> | undefined;
export const enqueueTelegramHeartBatch = (item: TelegramHeartCandidate, process: TelegramHeartBatchProcess): boolean => batcher.enqueue(item, process);
export const interruptTelegramHeartBatch = (chatId: number, threadId = 0): void => batcher.interrupt(chatId, threadId);
export function closeTelegramHeartBatches(): void {
  if (stopRecovery) recoveryDrain = stopRecovery(); stopRecovery = undefined; batcher.close();
}
export async function drainTelegramHeartBatches(): Promise<void> { closeTelegramHeartBatches(); await recoveryDrain; await batcher.drain(); }
export function _resetTelegramHeartBatches(): void { closeTelegramHeartBatches(); batcher = new TelegramHeartBatcher(); }
/** Only the configured ingress authority starts this recovery scan. SQLite
 * fences processes sharing its file; independent database copies are not HA. */
export function startTelegramHeartBatchRecovery(process: TelegramHeartBatchProcess, ready: () => boolean | Promise<boolean> = () => true): void {
  if (stopRecovery || env().META_TG_GROUP_COALESCE_MS <= 0) return;
  let stopped = false, loading: Promise<void> | undefined;
  const tick = async (): Promise<void> => {
    try { if (!stopped && await ready() && !stopped) batcher.recover(process); }
    catch { logger.warn('Telegram Heart recovery unavailable'); }
  };
  const timer = setInterval(() => {
    if (!loading) loading = tick().finally(() => { loading = undefined; });
  }, 1000); timer.unref?.();
  stopRecovery = async () => { stopped = true; clearInterval(timer); await loading; };
}
