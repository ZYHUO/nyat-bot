// ────────────────────────────────────────
// LLM metrics collector — 订阅 llmEvents,累加到 registry。零热路径成本(纯订阅)。
// ────────────────────────────────────────
//
// 暴露:
//   llm_requests_total{usage,label}        — 各用途/各 provider 调用次数
//   llm_tokens_total{usage,kind}           — prompt / completion / cached token 累计(回答「钱花在哪」+「缓存有没有命中」)
//   llm_latency_ms_sum{usage} / llm_latency_count{usage} — 平均延迟 = sum/count

import { llmEvents, type LlmResultEvent } from '../ai/events.js';
import { incrCounter } from './registry.js';

let inited = false;

export function initLlmMetrics(): void {
  if (inited) return;
  inited = true;
  llmEvents.on('result', (e: LlmResultEvent) => {
    incrCounter('llm_requests_total', { usage: e.usage, label: e.label, outcome: e.outcome });
    if (e.outcome === 'error') return; // failed attempt: only the request counter, no tokens/latency
    incrCounter('llm_tokens_total', { usage: e.usage, kind: 'prompt' }, e.promptTokens);
    incrCounter('llm_tokens_total', { usage: e.usage, kind: 'completion' }, e.completionTokens);
    if (e.cachedTokens > 0) incrCounter('llm_tokens_total', { usage: e.usage, kind: 'cached' }, e.cachedTokens);
    incrCounter('llm_latency_ms_sum', { usage: e.usage }, e.latencyMs);
    incrCounter('llm_latency_count', { usage: e.usage });
  });
}
