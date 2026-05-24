// ────────────────────────────────────────
// Phase 1: Debounce buffer (per chat)
// 借鉴 MaiBot heart_flow 的"消息静默期"思路
// ────────────────────────────────────────
//
// 设计目标：把同一 chatId 内连续到达的消息合并成一批，让 judge / gate
// 只对"批中最后一条"做完整决策，避免每条消息都触发独立的 reply 流程。
//
// 工作流程：
//   handler → enqueueWithDebounce(data)
//        ├── 直接交互 / 已禁用 / edits → 立刻 enqueue（透传）
//        └── 否则进入 buffer
//             ├── 滑动窗口 timer：每条新消息重置 (默认 2000ms)
//             └── 硬截止 timer：第一条消息进 buffer 起算 (默认 8000ms)
//        flush 时：
//           - 整批按时间序 enqueue 到 BullMQ
//           - 每条消息附带 coalesce 元数据 (batchSize, isLastInBatch)
//           - pipeline.ts 看到 !isLastInBatch 时只做 tracking，不跑 judge/reply
//
// 故障安全：进程退出前应调用 flushAllBuffers() 避免消息丢失。
// 单元测试通过 _resetBuffers / _getBufferSize 暴露内部状态。

import { enqueue } from '../../queue/producer.js';
import type { MessageJobData } from '../../queue/jobs.js';
import { env } from '../../env.js';
import { logger } from '../../shared/logger.js';

interface BufferedMessage {
  data: MessageJobData;
  receivedAt: number;
}

interface ChatBuffer {
  chatId: number;
  messages: BufferedMessage[];
  flushTimer: NodeJS.Timeout | undefined;
  hardDeadlineTimer: NodeJS.Timeout | undefined;
  firstReceivedAt: number;
}

const _buffers = new Map<number, ChatBuffer>();

export type FlushReason = 'window' | 'hard' | 'force' | 'direct_interaction';

export interface EnqueueOptions {
  /** Skip debounce, enqueue immediately. Also flushes any pending buffer for this chat. */
  bypassDebounce?: boolean;
}

/**
 * Enqueue a message, optionally buffered for the debounce window.
 * Returns a BullMQ jobId if enqueued immediately, or undefined when buffered.
 */
export async function enqueueWithDebounce(
  data: MessageJobData,
  opts?: EnqueueOptions,
): Promise<string | undefined> {
  const e = env();

  // Disabled / passthrough cases
  if (
    !e.TIMING_GATE_ENABLED ||
    e.TIMING_DEBOUNCE_MS <= 0 ||
    data.type !== 'message' ||
    data.isEdit
  ) {
    return enqueue(data);
  }

  if (opts?.bypassDebounce) {
    // Direct interaction: flush any pending buffer first (so older
    // buffered messages are processed before this direct one), then enqueue.
    await flushBuffer(data.chatId, 'direct_interaction');
    return enqueue(data);
  }

  // Buffer the message
  let buf = _buffers.get(data.chatId);
  const now = Date.now();
  if (!buf) {
    buf = {
      chatId: data.chatId,
      messages: [],
      flushTimer: undefined,
      hardDeadlineTimer: undefined,
      firstReceivedAt: now,
    };
    _buffers.set(data.chatId, buf);
  }

  buf.messages.push({ data, receivedAt: now });

  // Sliding window timer (reset on each new message)
  if (buf.flushTimer) clearTimeout(buf.flushTimer);
  buf.flushTimer = setTimeout(() => {
    void flushBuffer(data.chatId, 'window');
  }, e.TIMING_DEBOUNCE_MS);

  // Hard deadline timer (set once)
  if (!buf.hardDeadlineTimer) {
    const elapsed = now - buf.firstReceivedAt;
    const remaining = Math.max(0, e.TIMING_DEBOUNCE_MAX_BUFFER_MS - elapsed);
    buf.hardDeadlineTimer = setTimeout(() => {
      void flushBuffer(data.chatId, 'hard');
    }, remaining);
  }

  logger.debug(
    {
      chatId: data.chatId,
      messageId: data.messageId,
      bufSize: buf.messages.length,
    },
    'Message buffered for debounce',
  );

  return undefined;
}

/**
 * Force-flush a single chat's buffer, enqueuing all messages in arrival order
 * with `coalesce` metadata. Idempotent — safe to call when buffer is empty.
 */
export async function flushBuffer(
  chatId: number,
  reason: FlushReason = 'force',
): Promise<void> {
  const buf = _buffers.get(chatId);
  if (!buf) return;

  if (buf.flushTimer) {
    clearTimeout(buf.flushTimer);
    buf.flushTimer = undefined;
  }
  if (buf.hardDeadlineTimer) {
    clearTimeout(buf.hardDeadlineTimer);
    buf.hardDeadlineTimer = undefined;
  }
  _buffers.delete(chatId);

  if (buf.messages.length === 0) return;

  const lastMsgId = buf.messages.at(-1)?.data.messageId;
  const batchSize = buf.messages.length;

  for (const m of buf.messages) {
    const enriched: MessageJobData = {
      ...m.data,
      coalesce: {
        batchSize,
        isLastInBatch: m.data.messageId === lastMsgId,
        flushReason: reason,
      },
    };
    try {
      await enqueue(enriched);
    } catch (err) {
      logger.warn(
        { err, chatId, messageId: m.data.messageId },
        'Debounce flush enqueue failed',
      );
    }
  }

  if (batchSize > 1 || reason !== 'window') {
    logger.info(
      { chatId, batchSize, reason },
      'Debounce buffer flushed',
    );
  }
}

/** Flush every buffer (call on graceful shutdown). */
export async function flushAllBuffers(): Promise<void> {
  const ids = Array.from(_buffers.keys());
  await Promise.all(ids.map((id) => flushBuffer(id, 'force')));
}

// ── test helpers ──
export function _getBufferSize(chatId: number): number {
  return _buffers.get(chatId)?.messages.length ?? 0;
}

export function _hasBuffer(chatId: number): boolean {
  return _buffers.has(chatId);
}

export function _resetBuffers(): void {
  for (const buf of _buffers.values()) {
    if (buf.flushTimer) clearTimeout(buf.flushTimer);
    if (buf.hardDeadlineTimer) clearTimeout(buf.hardDeadlineTimer);
  }
  _buffers.clear();
}
