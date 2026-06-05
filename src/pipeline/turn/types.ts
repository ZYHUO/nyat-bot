// ────────────────────────────────────────
// Turn Actor — 类型定义
// ────────────────────────────────────────
//
// MaiBot MaiSaka 式 per-chat 认知回合:消息只进 pending 缓冲,
// 由一个(每 chat 最多一个)turn job 统一消化、判断、行动。
// 详见 docs/maibot-framework-gap-analysis.md G1 与 docs/turn-actor/。

import type { UpdateLike } from '../../shared/types.js';

/** 触发一个回合的原因(对应 MaiBot 内部队列的 message/timeout/proactive) */
export type TurnTrigger = 'message' | 'direct' | 'wait_timeout' | 'proactive';

/** pending 缓冲里的一条原始更新(ingress 写入,turn 消化) */
export interface PendingEntry {
  update: UpdateLike;
  chatId: number;
  messageId?: number;
  enqueuedAt: number;
  /** 直接交互(@/回复 bot/私聊/命令)→ 回合应近即时开火且必须处理 */
  direct?: boolean;
  isEdit?: boolean;
}

/** chat_turn job 的载荷 */
export interface TurnJobPayload {
  trigger: TurnTrigger;
  scheduledAt: number;
  /** direct 交互排的回合:跳过节奏门控的克制路径(对应 MaiBot forced-continue) */
  directPriority?: boolean;
  /** wait_timeout 回合:wait 决策时的锚点消息 */
  anchorMessageId?: number;
}

/** 回合元数据(Redis hash xxb:turn:meta:{chatId}) */
export interface TurnMeta {
  /** 当前已排程(delayed/waiting)的 turn jobId;无则 undefined */
  scheduledJobId?: string;
  /** pending 缓冲中第一条消息的时间(硬上限去抖的锚) */
  firstPendingAt?: number;
  /** 最近一条入站消息时间(打断后静默期用) */
  lastMsgAt?: number;
  /** 见过的最大 messageId(发送前新鲜度水位) */
  highWatermark?: number;
  /** 回合纪元:每次开始新回合 +1;abort/陈旧检测的代际标识 */
  epoch?: number;
  /** 活跃回合期间有新消息到达 → 回合结束后需立即再排程 */
  dirty?: boolean;
}
