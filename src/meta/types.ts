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
}

export interface DispatchTask {
  id: string;
  chatId: number;
  contentDirection: string;
  toneGuidance?: string;
  quoteMessageIds?: number[];
  trackingKey?: string;
  createdAt: number;
  status: 'queued' | 'running' | 'done' | 'failed';
  resultSummary?: string;
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
