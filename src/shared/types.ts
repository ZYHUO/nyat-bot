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
  type: 'message' | 'allowlist_review';
  chatId: number;
  messageId?: number;
  update: UpdateLike;
  enqueuedAt: number;
}
