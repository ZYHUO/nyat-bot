// ────────────────────────────────────────
// LLM event bus — 借鉴 CGM:provider 层每次调用后发事件,metrics/日志只订阅,零热路径成本。
// ────────────────────────────────────────

import { EventEmitter } from 'node:events';
import type { AICallResult } from './types.js';

export interface LlmResultEvent {
  usage: string;       // caller purpose: reply / judge / vision / ...
  label: string;       // which provider attempt this was
  model: string;
  outcome: 'ok' | 'error';
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  /** Undefined means unreported/invalid, while zero is an observed miss. */
  cachedTokens?: number;
  cacheWriteTokens?: number;
  /** Only an explicitly known input total may enter the cache denominator. */
  inputKnown?: boolean;
  transportPath?: AICallResult['transportPath'];
  /** Explicit internal request count, when supplied; coverage remains per result. */
  providerRequests?: number;
  /**
   * 归属会话。可选 —— cron / 后台任务 / 尚未接线的调用点没有它。
   * social-ledger 用它把 LLM 调用摊到具体群上("每回复几次调用"是 G8 的核心成本
   * 指标)。没有 chatId 的调用**不计入**任何群:宁可少算,也不要把别处的开销
   * 摊到某个群头上,那会让 A/B 的分子失真。
   */
  chatId?: number;
}

export const llmEvents = new EventEmitter();
llmEvents.setMaxListeners(50);

/** Configuration identifiers only; never derive metric dimensions from message text. */
export function metricDimension(value: unknown): string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.\/-]{0,95}$/.test(value) && !/^sk-/i.test(value)
    ? value : 'unknown';
}

const TRANSPORT_PATHS = new Set(['anthropic_json', 'openai_json', 'openai_stream', 'openai_sdk']);

export function cacheDimensions(event: LlmResultEvent): Record<'usage' | 'label' | 'model' | 'path', string> {
  return {
    usage: metricDimension(event.usage), label: metricDimension(event.label), model: metricDimension(event.model),
    path: event.transportPath && TRANSPORT_PATHS.has(event.transportPath) ? event.transportPath : 'unknown',
  };
}

export function validTokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Shared by in-memory metrics and the durable ledger, so their denominators agree. */
export function cacheObservation(event: LlmResultEvent): {
  coverage: 'known' | 'input_unknown' | 'cache_unknown';
  input: number | undefined;
  read: number | undefined;
  write: number | undefined;
} {
  const input = event.inputKnown === true && validTokenCount(event.promptTokens) ? event.promptTokens : undefined;
  const read = input !== undefined && validTokenCount(event.cachedTokens) && event.cachedTokens <= input
    ? event.cachedTokens : undefined;
  const write = input !== undefined && validTokenCount(event.cacheWriteTokens) && event.cacheWriteTokens <= input
    ? event.cacheWriteTokens : undefined;
  return { coverage: input === undefined ? 'input_unknown' : read === undefined ? 'cache_unknown' : 'known',
    input, read, write };
}

/** Emit a successful LLM result. Metrics must NEVER break a call → fully guarded. */
export function emitLlmResult(usage: string, r: AICallResult, chatId?: number): void {
  try {
    llmEvents.emit('result', {
      usage: metricDimension(usage),
      label: metricDimension(r.label),
      model: metricDimension(r.model),
      outcome: 'ok',
      latencyMs: r.latencyMs,
      promptTokens: validTokenCount(r.tokenUsage.prompt) ? r.tokenUsage.prompt : 0,
      completionTokens: validTokenCount(r.tokenUsage.completion) ? r.tokenUsage.completion : 0,
      cachedTokens: validTokenCount(r.tokenUsage.cached) ? r.tokenUsage.cached : undefined,
      cacheWriteTokens: validTokenCount(r.tokenUsage.cacheWrite) ? r.tokenUsage.cacheWrite : undefined,
      inputKnown: r.tokenUsage.inputKnown === true && validTokenCount(r.tokenUsage.prompt),
      transportPath: r.transportPath && TRANSPORT_PATHS.has(r.transportPath) ? r.transportPath : undefined,
      providerRequests: validTokenCount(r.providerRequests) && r.providerRequests > 0 ? r.providerRequests : undefined,
      chatId,
    } as LlmResultEvent);
  } catch { /* never throw from telemetry */ }
}

/** Emit a failed attempt (429 / timeout / fallback transition) so retries & per-label error rates are visible. */
export function emitLlmError(usage: string, label: string, model: string, chatId?: number): void {
  try {
    llmEvents.emit('result', {
      usage: metricDimension(usage), label: metricDimension(label), model: metricDimension(model), outcome: 'error',
      latencyMs: 0, promptTokens: 0, completionTokens: 0, inputKnown: false,
      chatId,
    } as LlmResultEvent);
  } catch { /* never throw from telemetry */ }
}
