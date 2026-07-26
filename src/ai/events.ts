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
  cachedTokens: number; // prompt-cache hit tokens (DeepSeek/Claude)
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

/** Emit a successful LLM result. Metrics must NEVER break a call → fully guarded. */
export function emitLlmResult(usage: string, r: AICallResult, chatId?: number): void {
  try {
    llmEvents.emit('result', {
      usage,
      label: r.label,
      model: r.model,
      outcome: 'ok',
      latencyMs: r.latencyMs,
      promptTokens: r.tokenUsage.prompt,
      completionTokens: r.tokenUsage.completion,
      cachedTokens: r.tokenUsage.cached ?? 0,
      chatId,
    } as LlmResultEvent);
  } catch { /* never throw from telemetry */ }
}

/** Emit a failed attempt (429 / timeout / fallback transition) so retries & per-label error rates are visible. */
export function emitLlmError(usage: string, label: string, model: string, chatId?: number): void {
  try {
    llmEvents.emit('result', {
      usage, label, model, outcome: 'error',
      latencyMs: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0,
      chatId,
    } as LlmResultEvent);
  } catch { /* never throw from telemetry */ }
}
