import { env } from '../env.js';
import { logger } from '../shared/logger.js';
import type { FormattedMessage } from '../shared/types.js';
import type { AttentionLayer } from './types.js';
import { isOneBotMessageRecalled } from '../platform/onebot-notices.js';
import { isMessageAnswered } from './answered.js';

export interface QqHeartCandidate {
  chatId: number;
  formatted: FormattedMessage;
  layer: AttentionLayer;
  addressed: boolean;
  ongoingFollowup?: boolean;
  cognitiveAnchorEventId?: string;
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

  enqueue(item: QqHeartCandidate, process: ProcessBatch): boolean {
    if (this.closed) return false;
    let state = this.chats.get(item.chatId);
    if (!state) {
      if (this.chats.size >= MAX_CHATS) return this.reject(item.chatId);
      state = { entries: [], process, firstAt: Date.now(), lastAt: Date.now(), ready: false,
        running: false, controller: new AbortController() };
      this.chats.set(item.chatId, state);
    }
    if (state.entries.some(entry => entry.formatted.messageId === item.formatted.messageId)) return true;
    if (state.entries.length >= MAX_PENDING_PER_CHAT) return this.reject(item.chatId);
    if (!state.entries.length) state.firstAt = Date.now();
    state.entries.push(item); state.lastAt = Date.now(); state.process = process;
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
      void (async () => {
        try {
          const live: QqHeartCandidate[] = [];
          for (const item of entries) {
            if (!isOneBotMessageRecalled(chatId, item.formatted.messageId)
              && !await isMessageAnswered(chatId, item.formatted.messageId)) live.push(item);
          }
          if (live.length && !state.controller.signal.aborted) {
            logger.info({ chatId, count: live.length, bufferedCount: entries.length,
              firstMessageId: live[0]!.formatted.messageId, lastMessageId: live[live.length - 1]!.formatted.messageId,
              addressedCount: live.filter(item => item.addressed).length,
              ongoingFollowupCount: live.filter(item => item.ongoingFollowup).length }, 'QQ Heart batch flushed');
            await process(live, state.controller.signal);
          }
        } catch {
          // In particular, recall-store errors cannot release unverified items.
          logger.warn({ chatId, count: entries.length }, 'QQ Heart batch unavailable; no decision dispatched');
        } finally {
          this.inflight--; state.running = false;
          if (!state.entries.length) this.chats.delete(chatId);
          this.pump();
        }
      })();
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
}

let batcher = new QqHeartBatcher();
export const enqueueQqHeartBatch = (item: QqHeartCandidate, process: ProcessBatch): boolean => batcher.enqueue(item, process);
/** Stop ingress first; abort decisions before workers/Redis are closed. */
export const closeQqHeartBatches = (): void => batcher.close();
export function _resetQqHeartBatches(): void { batcher.close(); batcher = new QqHeartBatcher(); }
