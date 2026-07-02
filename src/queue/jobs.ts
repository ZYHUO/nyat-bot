// ────────────────────────────────────────
// Queue job 类型定义
// ────────────────────────────────────────

import type { UpdateLike } from '../shared/types.js';
import type { PendingEntry, TurnJobPayload } from '../pipeline/turn/types.js';

export const QUEUE_NAME = 'xxb-messages';

/**
 * Coalesce metadata attached by Phase 1 debounce buffer.
 * When set, only `isLastInBatch === true` jobs run the full
 * judge → gate → reply pipeline; earlier jobs do tracking-only.
 */
export interface CoalesceInfo {
  batchSize: number;
  isLastInBatch: boolean;
  flushReason: 'window' | 'hard' | 'force' | 'direct_interaction';
}

export interface MessageJobData {
  type: 'message' | 'allowlist_review' | 'wait_resume' | 'chat_turn' | 'defer_resume';
  chatId: number;
  messageId?: number;
  isEdit?: boolean;
  update: UpdateLike;
  enqueuedAt: number;
  /** Phase 1: debounce coalesce metadata */
  coalesce?: CoalesceInfo;
  /**
   * Phase 4: tracking-only flag — pipeline runs format/addMessage/activity
   * tracking but skips judge / gate / reply. Set when chat is in STOP/WAIT
   * and the incoming message is not a direct interaction (no wake-up).
   */
  skipReply?: boolean;
  /** Phase 4: wait-resume payload (only for type='wait_resume') */
  waitResume?: {
    /** When this wait was scheduled (epoch ms) */
    scheduledAt: number;
    /** Original wait duration in seconds */
    waitSec: number;
    /** Anchor messageId — the last message at time of wait decision */
    anchorMessageId?: number;
    obligationId?: string;
  };
  /** Turn actor: payload for type='chat_turn' (per-chat cognition turn) */
  turn?: TurnJobPayload;
  /**
   * P0-B: defer-resume payload (only for type='defer_resume')。被 gate/心流
   * defer 的条目**存在 job 载荷里**而非 pending —— 窗口期内不会被别的回合
   * 提前 drain,也不污染 turn 调度指针(review finding #1 的根修)。
   */
  deferResume?: {
    scheduledAt: number;
    entries: PendingEntry[];
  };
}
