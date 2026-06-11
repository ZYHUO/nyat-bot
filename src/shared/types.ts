// ────────────────────────────────────────
// 全局类型定义
// ────────────────────────────────────────

export interface FormattedMessage {
  role: 'user' | 'assistant' | 'system';
  uid: number;
  username: string;
  fullName: string;
  timestamp: number;
  messageId: number;
  textContent: string;
  captionContent?: string;
  sticker?: {
    emoji: string;
    fileId: string;
    fileUniqueId: string;
    setName?: string;
    isAnimated?: boolean;
    isVideo?: boolean;
  };
  replyTo?: { messageId: number; uid: number; fullName: string; textSnippet: string; documentFileId?: string; documentMimeType?: string; documentFileName?: string; imageFileId?: string };
  isForwarded: boolean;
  forwardFrom?: string;
  imageFileId?: string;
  imageFileUniqueId?: string;
  imageDescriptions?: string[];
  audioFileId?: string;
  voiceFileId?: string;
  documentFileId?: string;
  documentMimeType?: string;
  documentFileName?: string;
  videoFileId?: string;
  videoNoteFileId?: string;
  isBot?: boolean;
  /** 匿名管理员（sender_chat 是群组）或频道发言（sender_chat 是频道） */
  isAnonymous?: boolean;
  /** 匿名身份类型 */
  anonymousType?: 'admin' | 'channel';
  /** Telegram custom tag (Bot API 9.5+, Premium feature) */
  senderTag?: string;
}

export type JudgeAction = 'REPLY' | 'IGNORE' | 'REJECT';
export type ReplyPath = 'direct' | 'planned';
export type ReplyTier = 'normal' | 'pro' | 'max';

export function resolveReplyPath(action: JudgeAction, replyPath?: ReplyPath): ReplyPath | undefined {
  if (action === 'REPLY') return replyPath ?? 'direct';
  return undefined;
}

export function resolveReplyTier(action: JudgeAction, replyTier?: ReplyTier): ReplyTier | undefined {
  if (action === 'REPLY') return replyTier ?? 'normal';
  return undefined;
}

export interface JudgeResult {
  action: JudgeAction;
  replyPath?: ReplyPath;
  replyTier?: ReplyTier;
  level: 'L0_RULE' | 'L1_MICRO' | 'L2_AI';
  rule?: string;
  confidence?: number;
  reasoning?: string;
  latencyMs: number;
}

export interface ReplyOutput {
  replyContent: string;
  targetMessageId: number;
  /** Up to 3 sticker intents in priority order */
  stickerIntent?: string[];
  replyQuote?: boolean;
  /** True if this segment was inserted by the humanizer as a filler — skip typo/afterthought/delete-resend */
  isInterjection?: boolean;
  /** G2: 模型把贴纸当一等动作选出来的 → 投递层跳过贴纸冷却 */
  modelStickerAct?: boolean;
  /** G10: 模型的投递意图 — 这句想停顿酝酿一拍再发 */
  hesitateBefore?: boolean;
}

export interface RetrievedContext {
  recent: FormattedMessage[];
  semantic: FormattedMessage[];
  thread: FormattedMessage[];
  entity: FormattedMessage[];
  merged: FormattedMessage[];
  tokenCount: number;
}

// Structural shape of a Telegram Update, wide enough to accept both grammy's
// strongly-typed Update and ad-hoc test fixtures while keeping field names
// statically known at the formatter boundary.
export interface UpdateLike {
  update_id?: unknown;
  message?: unknown;
  edited_message?: unknown;
  channel_post?: unknown;
  edited_channel_post?: unknown;
}

export interface ChatJob {
  type: 'message' | 'allowlist_review' | 'wait_resume';
  chatId: number;
  messageId?: number;
  update: UpdateLike;
  enqueuedAt: number;
  /** Phase 1: debounce coalesce metadata. Non-last-in-batch jobs skip judge/reply. */
  coalesce?: {
    batchSize: number;
    isLastInBatch: boolean;
    flushReason: 'window' | 'hard' | 'force' | 'direct_interaction';
  };
  /** Phase 4: tracking-only flag (chat in STOP/WAIT and not a direct interaction) */
  skipReply?: boolean;
  /** Phase 4: wait-resume metadata (only set when type='wait_resume'). */
  waitResume?: {
    scheduledAt: number;
    waitSec: number;
    anchorMessageId?: number;
  };
  /**
   * Turn actor in-process context (NEVER serialized into BullMQ — the actor
   * invokes processPipeline directly). signal: interrupt for the expensive
   * writer stage (G3); gateBypass: replan skips the timing gate (MaiBot
   * forced-continue after interrupt); epoch: cognition-turn generation id.
   */
  turnContext?: {
    signal?: AbortSignal;
    epoch?: number;
    gateBypass?: boolean;
    isReplan?: boolean;
    /** G4: messageIds of the whole drained burst (oldest→newest) — judge/reply treat it as one thought */
    burstMessageIds?: number[];
    /** L1: 心流决定接话时的内心独白 — 写手顺着同一个念头开笔 */
    heartWhy?: string;
    /**
     * 心流分支算好的自我状态快照 — 同一回合写手直接复用,不再二次
     * 拼装(审计 #38:composeSelfState 一回合曾跑两次,~4 RTT × 2)。
     */
    selfState?: { narration: string; narrationNoThought: string; energy: number };
    /**
     * G5: wait-resume replay — the anchor entry already went through all
     * bookkeeping stages on first processing; skip context-save/tracking
     * side-effects and go straight to judge→reply.
     */
    isWaitReplay?: boolean;
  };
}
