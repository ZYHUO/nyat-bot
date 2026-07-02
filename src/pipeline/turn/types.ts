// ────────────────────────────────────────
// Turn Actor — 类型定义
// ────────────────────────────────────────
//
// MaiBot MaiSaka 式 per-chat 认知回合:消息只进 pending 缓冲,
// 由一个(每 chat 最多一个)turn job 统一消化、判断、行动。
// 详见 docs/maibot-framework-gap-analysis.md G1 与 docs/turn-actor/。

import type { UpdateLike } from '../../shared/types.js';

export type TurnTrigger = 'message' | 'direct' | 'wait_timeout' | 'proactive' | 'gate_defer';

export interface PendingEntry {
  update: UpdateLike;
  chatId: number;
  messageId?: number;
  enqueuedAt: number;
  direct?: boolean;
  isEdit?: boolean;
  waitReplay?: boolean;
  sleepCatchup?: boolean;
  obligationId?: string;
  obligationTargetUid?: number;
  obligationStrong?: boolean;
  /** P0-B:gate defer 重评条目 — 已完成入册,回放时跳过 bookkeeping,但 gate 要重跑。 */
  deferReplay?: boolean;
  /** P0-B:该条消息已被 defer 的次数(防无限 defer 循环)。 */
  deferCount?: number;
  /** P2-F:wait 锚点携带的等待秒数(回访提示"你刚等了 N 秒"用)。 */
  waitSec?: number;
}

export interface TurnJobPayload {
  trigger: TurnTrigger;
  scheduledAt: number;
  directPriority?: boolean;
  anchorMessageId?: number;
  obligationId?: string;
  obligationTargetUid?: number;
  obligationStrong?: boolean;
}

export interface TurnMeta {
  scheduledJobId?: string;
  firstPendingAt?: number;
  lastMsgAt?: number;
  highWatermark?: number;
  epoch?: number;
  dirty?: boolean;
}
