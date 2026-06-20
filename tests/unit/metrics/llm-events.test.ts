import { describe, it, expect } from 'vitest';
import { initLlmMetrics } from '../../../src/metrics/llm-collector.js';
import { emitLlmResult, emitLlmError } from '../../../src/ai/events.js';
import { renderMetrics } from '../../../src/metrics/registry.js';

describe('LLM event bus → metrics', () => {
  it('emit→subscribe→counter path records tokens, cache, latency, and errors', () => {
    initLlmMetrics(); // idempotent
    const u = 'reply_test_unique'; // unique usage label to avoid cross-test counter bleed
    emitLlmResult(u, {
      content: 'hi',
      tokenUsage: { prompt: 1000, completion: 50, total: 1050, cached: 800 },
      model: 'deepseek-v4-flash', label: 'deepseek', latencyMs: 1200,
    });
    emitLlmError(u, 'deepseek', 'deepseek-v4-flash');

    const out = renderMetrics();
    expect(out).toContain(`llm_requests_total{usage="${u}",label="deepseek",outcome="ok"} 1`);
    expect(out).toContain(`llm_requests_total{usage="${u}",label="deepseek",outcome="error"} 1`);
    expect(out).toContain(`llm_tokens_total{usage="${u}",kind="prompt"} 1000`);
    expect(out).toContain(`llm_tokens_total{usage="${u}",kind="cached"} 800`);
    expect(out).toContain(`llm_latency_ms_sum{usage="${u}"} 1200`);
  });
});
