// Meta + Subagent shared types (CGM-shaped, nyatbot-hosted)

export type AttentionLayer = 'L0' | 'L1' | 'L1_CALLBACK' | 'L2';

export interface AttentionItem {
  id: string;
  chatId: number;
  layer: AttentionLayer;
  /** Higher = more urgent. */
  pressure: number;
  reason: string;
  messageId?: number;
  userId?: number;
  textPreview?: string;
  createdAt: number;
  payload?: Record<string, unknown>;
  /** Telegram forum topic (supergroup thread) id; absent for non-forum / General topic. */
  messageThreadId?: number;
}

export interface DispatchTask {
  id: string;
  chatId: number;
  contentDirection: string;
  toneGuidance?: string;
  quoteMessageIds?: number[];
  /**
   * Same-burst sibling messageIds (not the primary quote). Marked answered only
   * after a successful sendText so a failed CodeAct can still re-fire them.
   */
  relatedQuoteIds?: number[];
  /** 要回的那个人（用于分人设 persona/{uid}.md）；来自 Attention.userId */
  targetUserId?: number;
  trackingKey?: string;
  createdAt: number;
  status: 'queued' | 'running' | 'done' | 'failed';
  /** 长时间 Agent 循环：当前是第几段（0-based）。 */
  segment?: number;
  /** checkpoint 在 Redis 里的 key；续跑时据此恢复 history。 */
  checkpointKey?: string;
  /** 该任务累计已消耗的轮数（跨段）。 */
  totalTurns?: number;
  resultSummary?: string;
  /** Telegram forum topic (supergroup thread) id; absent for non-forum / General topic. */
  messageThreadId?: number;
}

export interface SubagentCallback {
  id: string;
  taskId: string;
  chatId: number;
  summary: string;
  ok: boolean;
  createdAt: number;
}

export interface MetaSessionDigest {
  at: number;
  text: string;
}
