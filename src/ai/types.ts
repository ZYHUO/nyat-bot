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

/** Multimodal content part for vision/audio models */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; image: string } // data URL or URL
  | { type: 'audio'; audio: string; format: string }; // raw base64 (no data: prefix) + container format (wav/mp3/ogg/m4a)

export interface AICallOptions {
  usage: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string | ContentPart[] }>;
  stream?: boolean;
  maxTokens?: number;
  temperature?: number;
  /**
   * External abort signal (e.g. turn-actor interrupt when new messages land
   * mid-generation). Merged with the per-label timeout signal; an abort here
   * surfaces as AIError code 'AI_ABORTED' and is NOT retried by the fallback
   * chain.
   *
   * 注意:不要把 AbortSignal.timeout(...) 烧进这个 signal —— 它会被 fallback
   * 链的**每一次**尝试复用,首跳超时后所有 backup 立刻 DOA(信号中毒)。
   * 想限定每次尝试的时长用 maxTimeoutMs。
   */
  signal?: AbortSignal;
  /**
   * Per-attempt wall-clock cap (ms). Caps the usage label's own timeout for
   * EACH attempt (primary / hedge / every backup) via the per-attempt
   * AbortSignal.timeout inside callModel, so a slow primary still leaves the
   * backups alive. Worst-case total wall-clock = attempts × min(usage.timeout,
   * maxTimeoutMs) — callers on latency-sensitive paths should keep this tight.
   */
  maxTimeoutMs?: number;
  /**
   * Skip LLM metrics emission for this call (llmEvents). Used by synthetic/diagnostic
   * traffic (e.g. cache warmup) so it doesn't pollute the per-usage metrics it's meant to observe.
   */
  suppressMetrics?: boolean;
}

export interface AICallResult {
  content: string;
  tokenUsage: { prompt: number; completion: number; total: number; cached?: number };
  model: string;
  label: string;
  latencyMs: number;
  fromCache?: boolean;
}
