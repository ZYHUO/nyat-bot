// ────────────────────────────────────────
// Queue job 类型定义
// ────────────────────────────────────────

import type { UpdateLike } from '../shared/types.js';

export const QUEUE_NAME = 'xxb-messages';

export interface MessageJobData {
  type: 'message' | 'allowlist_review';
  chatId: number;
  messageId?: number;
  isEdit?: boolean;
  update: UpdateLike;
  enqueuedAt: number;
}
