// ────────────────────────────────────────
// Tracking System — Types
// ────────────────────────────────────────

export interface ActivitySummary {
  messages1min: number;
  messages5min: number;
  messages15min: number;
  messages1hour: number;
  activeUsers5min: number;
  activityLevel: '热聊' | '活跃' | '正常' | '冷清' | '沉寂';
}

export interface ModelStatus {
  status: 'up' | 'slow' | 'down';
  latencyMs: number;
}

export interface ReplyOutcome {
  ts: number;
  trigger: string;
  reply: string;
  outcome: 'positive' | 'negative';
  signal: string;
  action: string;
}
