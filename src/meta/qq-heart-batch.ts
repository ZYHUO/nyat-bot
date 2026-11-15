import { env } from '../env.js';
import { logger } from '../shared/logger.js';
import type { FormattedMessage } from '../shared/types.js';
import type { AttentionLayer } from './types.js';
import { isOneBotMessageRecalled } from '../platform/onebot-notices.js';
import { isMessageAnswered } from './answered.js';
import { hasUnansweredIntentRevision } from './pending-intent.js';
import { acceptInbox, claimInbox, expireInboxClaims, holdPendingInbox, listPendingInbox, renewInboxClaim, settleInbox } from '../ingress/inbox-store.js';
import type { InboxClaim, InboxEntry } from '../ingress/inbox-store.js';
import { isCurrentInboxScope } from '../ingress/durable.js';
import { eventHash } from '../shared/event-identity.js';

export interface QqHeartCandidate {
  chatId: number;
  formatted: FormattedMessage;
  layer: AttentionLayer;
  addressed: boolean;
  ongoingFollowup?: boolean;
  cognitiveAnchorEventId?: string;
  /** Host-owned durable candidate reference; never synthesized from model text. */
  inboxEventId?: string;
}
type ProcessBatch = (items: QqHeartCandidate[], signal: AbortSignal) => Promise<void>;
interface PendingChat {
  entries: QqHeartCandidate[];
  process: ProcessBatch;
  firstAt: number;
  lastAt: number;
  ready: boolean;
  running: boolean;
  timer?: ReturnType<typeof setTimeout>;
  controller: AbortController;
}
const MAX_CHATS = 64;
const MAX_PENDING_PER_CHAT = 32;
const MAX_INFLIGHT = 4;

/** Context is persisted by ingress first. This bounded queue delays judgment,
 * not ingestion, and carries real message references throughout. */
class QqHeartBatcher {
  private readonly chats = new Map<number, PendingChat>();
  private closed = false;
  private inflight = 0;
  private readonly running = new Set<Promise<void>>();

  enqueue(item: QqHeartCandidate, process: ProcessBatch): boolean {
    if (this.closed) return false;
    if (env().DURABLE_INGRESS_ENABLED && !item.inboxEventId) {
      const identity = item.formatted.eventIdentity;
      if (!identity || identity.ref.conversation.platform !== 'qq') throw new Error('qq_batch_source_missing');
      const entry = acceptInbox({ lane: 'qq_heart', chatId: item.chatId,
        identity: { ...identity, eventId: eventHash('qq-heart:' + identity.eventId) }, payload: item });
      if (entry.state !== 'pending') return true;
      item = { ...(entry.payload as QqHeartCandidate), inboxEventId: entry.eventId };
    }
    let state = this.chats.get(item.chatId);
    if (!state) {
      if (this.chats.size >= MAX_CHATS) return item.inboxEventId ? true : this.reject(item.chatId);
      state = { entries: [], process, firstAt: Date.now(), lastAt: Date.now(), ready: false,
        running: false, controller: new AbortController() };
      this.chats.set(item.chatId, state);
    }
    if (state.entries.some(entry => entry.formatted.messageId === item.formatted.messageId)) return true;
    if (state.entries.length >= MAX_PENDING_PER_CHAT) return item.inboxEventId ? true : this.reject(item.chatId);
    const receivedAt = item.inboxEventId ? item.formatted.eventIdentity!.receivedAt : Date.now();
    if (item.inboxEventId && state.entries.length && receivedAt > Math.min(
      state.lastAt + env().META_QQ_GROUP_COALESCE_MS, state.firstAt + env().META_QQ_GROUP_COALESCE_MAX_MS,
    )) {
      // Recovered inputs keep their original intake times. Do not turn a
      // twenty-minute gap into a fresh burst merely because one page loaded it.
      if (state.timer) clearTimeout(state.timer);
      state.timer = undefined; state.ready = true; this.pump();
      return true; // New cohort remains durable pending for the next page cycle.
    }
    if (!state.entries.length) state.firstAt = receivedAt;
    state.entries.push(item); state.lastAt = receivedAt; state.process = process;
    this.schedule(item.chatId, state);
    return true;
  }

  private reject(chatId: number): false {
    logger.warn({ chatId, reason: 'qq_heart_batch_capacity' }, 'QQ Heart candidate retained in context; decision queue full');
    return false;
  }

  private schedule(chatId: number, state: PendingChat): void {
    if (state.timer) clearTimeout(state.timer);
    state.ready = false;
    const e = env();
    const due = Math.min(state.lastAt + e.META_QQ_GROUP_COALESCE_MS, state.firstAt + e.META_QQ_GROUP_COALESCE_MAX_MS);
    state.timer = setTimeout(() => {
      state.timer = undefined; state.ready = true; this.pump();
    }, Math.max(0, due - Date.now()));
    state.timer.unref?.();
    // A chat's deadline is independent of every other chat.
    if (!this.chats.has(chatId)) clearTimeout(state.timer);
  }

  private pump(): void {
    if (this.closed) return;
    for (const [chatId, state] of [...this.chats].sort(([, a], [, b]) => a.firstAt - b.firstAt)) {
      if (this.inflight >= MAX_INFLIGHT) return;
      if (!state.ready || state.running || !state.entries.length) continue;
      const entries = state.entries.splice(0);
      const process = state.process;
      state.running = true; state.ready = false; this.inflight++;
      const running = (async () => {
        const claims: InboxClaim[] = [];
        let heartbeat: ReturnType<typeof setInterval> | undefined;
        try {
          const live: QqHeartCandidate[] = [];
          for (const item of entries) {
            if (item.inboxEventId) {
              const identity = item.formatted.eventIdentity!;
              if (!isCurrentInboxScope({ chatId, identity } as InboxEntry)) {
                holdPendingInbox(item.inboxEventId, 'account_or_scope_changed'); continue;
              }
              const claim = claimInbox(item.inboxEventId);
              if (!claim) continue;
              claims.push(claim);
              // Redis answered checks may block. Renew from the first claim,
              // not only after every asynchronous preflight has returned.
              if (!heartbeat) {
                heartbeat = setInterval(() => {
                  try { if (claims.some(current => !renewInboxClaim(current))) state.controller.abort(); }
                  catch { state.controller.abort(); }
                }, 10_000); heartbeat.unref?.();
              }
            }
            if (!isOneBotMessageRecalled(chatId, item.formatted.messageId)
              && (hasUnansweredIntentRevision(item.formatted.pendingIntent) || !await isMessageAnswered(chatId, item.formatted.messageId))) {
              const reply = item.formatted.replyTo;
              live.push(reply && isOneBotMessageRecalled(chatId, reply.messageId)
                ? { ...item, formatted: { ...item.formatted, replyTo: undefined } } : item);
            }
          }
          // A suspended process can miss all heartbeat intervals. Fence again
          // synchronously immediately before any Heart/reaction side effect.
          if (claims.some(claim => !renewInboxClaim(claim))) state.controller.abort();
          if (live.length && !state.controller.signal.aborted) {
            logger.info({ chatId, count: live.length, bufferedCount: entries.length,
              firstMessageId: live[0]!.formatted.messageId, lastMessageId: live[live.length - 1]!.formatted.messageId,
              addressedCount: live.filter(item => item.addressed).length,
              ongoingFollowupCount: live.filter(item => item.ongoingFollowup).length }, 'QQ Heart batch flushed');
            await process(live, state.controller.signal);
          }
          for (const claim of claims) settleInbox(claim, state.controller.signal.aborted ? 'unknown' : 'settled',
            state.controller.signal.aborted ? 'batch_aborted' : undefined);
        } catch {
          for (const claim of claims) {
            try { settleInbox(claim, 'unknown', 'batch_failed_after_start'); } catch { /* expired processing is held */ }
          }
          // In particular, recall-store errors cannot release unverified items.
          logger.warn({ chatId, count: entries.length }, 'QQ Heart batch unavailable; no decision dispatched');
        } finally {
          if (heartbeat) clearInterval(heartbeat);
          this.inflight--; state.running = false;
          if (!state.entries.length) this.chats.delete(chatId);
          else if (state.controller.signal.aborted && !this.closed) state.controller = new AbortController();
          this.pump();
        }
      })();
      this.running.add(running);
      void running.finally(() => this.running.delete(running));
    }
  }

  close(): void {
    this.closed = true;
    for (const state of this.chats.values()) {
      if (state.timer) clearTimeout(state.timer);
      state.controller.abort();
      state.entries.length = 0;
    }
    this.chats.clear();
  }
  async drain(): Promise<void> { this.close(); await Promise.all([...this.running]); }
}

let batcher = new QqHeartBatcher();
let stopRecovery: (() => Promise<void>) | undefined;
let recoveryDrain: Promise<void> | undefined;
export const enqueueQqHeartBatch = (item: QqHeartCandidate, process: ProcessBatch): boolean => batcher.enqueue(item, process);
/** Stop ingress first; abort decisions before workers/Redis are closed. */
export const closeQqHeartBatches = (): void => { if (stopRecovery) recoveryDrain = stopRecovery(); stopRecovery = undefined; batcher.close(); };
export async function drainQqHeartBatches(): Promise<void> { closeQqHeartBatches(); await recoveryDrain; await batcher.drain(); }
export function _resetQqHeartBatches(): void { closeQqHeartBatches(); batcher = new QqHeartBatcher(); }

/** Elected ingress owner only. Pages are revisited; capacity never deletes durable work. */
export function startQqHeartBatchRecovery(process: ProcessBatch, ready: () => boolean | Promise<boolean> = () => true): void {
  if (!env().DURABLE_INGRESS_ENABLED || stopRecovery) return;
  let cursor = 0, stopped = false;
  let loading: Promise<void> | undefined;
  const tick = async (): Promise<void> => {
    try {
      if (!await ready() || stopped) return;
      expireInboxClaims();
      const page = listPendingInbox('qq_heart', cursor);
      if (!page.length) { cursor = 0; return; }
      for (const entry of page) {
        cursor = entry.sequence;
        if (!isCurrentInboxScope(entry)) { holdPendingInbox(entry.eventId, 'account_or_scope_changed'); continue; }
        batcher.enqueue({ ...(entry.payload as QqHeartCandidate), inboxEventId: entry.eventId }, process);
      }
    } catch { logger.warn('QQ durable batch recovery unavailable'); }
  };
  const timer = setInterval(() => {
    if (!loading) loading = tick().finally(() => { loading = undefined; });
  }, 1000); timer.unref?.();
  stopRecovery = async () => { stopped = true; clearInterval(timer); await loading; };
}
