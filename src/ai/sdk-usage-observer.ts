import { emitLlmResult } from './events.js';
import { normalizeSdkUsage } from './usage-normalization.js';

/** Observe each completed SDK tool step, never combine aggregate input with last-step cache metadata. */
export function createSdkUsageObserver(usage: string, label: string, model: string, chatId: number):
  (step: { usage: unknown; providerMetadata?: unknown; response?: { body?: unknown } }) => void {
  let previous = performance.now();
  return (step) => {
    const now = performance.now();
    const latencyMs = Math.max(0, Math.round(now - previous));
    previous = now;
    // Metrics must not fail a tool execution; no prompt, tool arguments or response text are emitted.
    try {
      emitLlmResult(usage, {
        content: '', label, model, latencyMs, transportPath: 'openai_sdk',
        tokenUsage: normalizeSdkUsage(step.usage, step.providerMetadata, step.response?.body),
      }, chatId);
    } catch { /* observation must not change delivery */ }
  };
}
