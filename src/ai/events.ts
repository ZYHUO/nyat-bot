// ────────────────────────────────────────
// LLM event bus — 借鉴 CGM:provider 层每次调用后发事件,metrics/日志只订阅,零热路径成本。
// ────────────────────────────────────────

import { EventEmitter } from 'node:events';
import type { AICallResult } from './types.js';

export interface LlmResultEvent {
  usage: string;       // caller purpose: reply / judge / vision / ...
  label: string;       // which provider actually served
  model: string;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number; // prompt-cache hit tokens (DeepSeek/Claude)
}

export const llmEvents = new EventEmitter();
llmEvents.setMaxListeners(50);

/** Emit a successful LLM result. Metrics must NEVER break a call → fully guarded. */
export function emitLlmResult(usage: string, r: AICallResult): void {
  try {
    llmEvents.emit('result', {
      usage,
      label: r.label,
      model: r.model,
      latencyMs: r.latencyMs,
      promptTokens: r.tokenUsage.prompt,
      completionTokens: r.tokenUsage.completion,
      cachedTokens: r.tokenUsage.cached ?? 0,
    } as LlmResultEvent);
  } catch { /* never throw from telemetry */ }
}
