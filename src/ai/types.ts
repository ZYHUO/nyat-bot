// ────────────────────────────────────────
// AI 层类型定义
// ────────────────────────────────────────

export interface AILabel {
  name: string;
  endpoint: string;
  apiKeys: string[];
  model: string;
  stream?: boolean;
  apiFormat?: 'openai' | 'claude';
  reasoningEffort?: 'none' | 'low' | 'medium' | 'high';
  disableThinking?: boolean;
  capabilities?: { vision?: boolean; functionCalling?: boolean };
}

export interface AIUsage {
  label: string;
  backups: string[];
  timeout: number;
  maxTokens?: number;
  temperature?: number;
}

export enum ModelTier {
  L0_RULE = 'L0_RULE',
  M1_MICRO = 'M1_MICRO',
  M2_FAST = 'M2_FAST',
  M3_MAIN = 'M3_MAIN',
}

export interface HedgeConfig {
  primaryLabel: string;
  hedgeLabel: string;
  hedgeDelayMs: number;
}

/** Multimodal content part for vision models */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; image: string }; // data URL or URL

export interface AICallOptions {
  usage: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string | ContentPart[] }>;
  stream?: boolean;
  maxTokens?: number;
  temperature?: number;
}

export interface AICallResult {
  content: string;
  tokenUsage: { prompt: number; completion: number; total: number };
  model: string;
  label: string;
  latencyMs: number;
  fromCache?: boolean;
}
