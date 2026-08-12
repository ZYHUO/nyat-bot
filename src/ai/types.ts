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
  /** 跳过 TLS 证书校验(仅限自建/自签证书端点;强制走 raw fetch + insecure dispatcher)。 */
  insecureTLS?: boolean;
  /** 强制走 raw fetch(而非 AI SDK generateText):裸路径对空/畸形响应返空不崩。 */
  forceRaw?: boolean;
  /** per-label 每次尝试超时(ms)覆盖 usage 超时(仍受调用方 maxTimeoutMs 上限约束)。 */
  timeout?: number;
  /** per-label maxTokens 覆盖(给推理模型放宽,防截断成空);调用方显式 maxTokens 优先。 */
  maxTokens?: number;
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
  | { type: 'image'; image: string; detail?: 'low' | 'high' | 'auto' } // data URL or URL; detail 默认 high(stepfun 识图需要)
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
  /**
   * Request strict JSON output (OpenAI/DeepSeek response_format json_object). Only takes effect
   * on the openai-format raw path AND when the prompt contains "json" (DeepSeek requirement);
   * ignored otherwise. Used by the reply writer to eliminate malformed/single-quoted output.
   */
  jsonMode?: boolean;
  /**
   * Treat an empty/blank model response as a failed attempt and continue the fallback chain.
   * Useful for low-frequency structured calls like heart/gate where an empty string is not
   * a meaningful success.
   */
  rejectEmpty?: boolean;
  /**
   * Set to false to disable the hedged request (primary+backup raced in parallel).
   * Hedging buys latency at 2x token cost — right for user-facing paths (reply/heart),
   * pure waste for fire-and-forget background batch (summarize/reflection/distill).
   */
  allowHedge?: boolean;
  /**
   * 归属会话,纯观测用途,不影响任何调用行为。透传进 llmEvents,让 social-ledger
   * 能把 LLM 调用摊到具体群上 —— "每回复几次调用"是 G8(合并人格决策)A/B 的
   * 核心成本指标,没有归属就只能看全局,而各群活跃度差异远大于 G8 本身的效应。
   * 不传的调用点(cron / 后台任务)不计入任何群。
   */
  chatId?: number;
}

export interface AICallResult {
  content: string;
  tokenUsage: { prompt: number; completion: number; total: number; cached?: number };
  model: string;
  label: string;
  latencyMs: number;
  fromCache?: boolean;
}
