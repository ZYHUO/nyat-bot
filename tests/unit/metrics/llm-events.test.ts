import { describe, it, expect } from 'vitest';
import { initLlmMetrics } from '../../../src/metrics/llm-collector.js';
import { emitLlmResult, emitLlmError, llmEvents, type LlmResultEvent } from '../../../src/ai/events.js';
import type { AICallResult } from '../../../src/ai/types.js';
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

  it('keeps unreported cache unknown, counts explicit misses, and uses only the same covered input', () => {
    initLlmMetrics();
    const usage = 'cache_coverage_fixture';
    const base = { content: 'SYNTHETIC_BODY_NEVER_EMITTED', model: 'model-a', label: 'provider-a',
      latencyMs: 10, transportPath: 'openai_sdk' as const, providerRequests: 2 };
    const captured: LlmResultEvent[] = [];
    const listener = (event: LlmResultEvent) => { if (event.usage === usage) captured.push(event); };
    llmEvents.on('result', listener);
    try {
      for (const tokenUsage of [
        { prompt: 100, completion: 1, total: 101, inputKnown: true },
        { prompt: 200, completion: 1, total: 201, inputKnown: true, cached: 0 },
        { prompt: 800, completion: 1, total: 801, inputKnown: true, cached: 600, cacheWrite: 100 },
        { prompt: 500, completion: 1, total: 501, inputKnown: false, cached: 400 },
      ]) emitLlmResult(usage, { ...base, tokenUsage });
    } finally { llmEvents.off('result', listener); }
    expect(captured[0]?.cachedTokens).toBeUndefined();
    expect(captured[1]?.cachedTokens).toBe(0);
    expect(captured[2]?.cacheWriteTokens).toBe(100);
    expect(captured[2]?.transportPath).toBe('openai_sdk');
    expect(captured[2]?.providerRequests).toBe(2);
    expect(JSON.stringify(captured)).not.toContain(base.content);
    const dimensions = `usage="${usage}",label="provider-a",model="model-a",path="openai_sdk"`;
    const metrics = renderMetrics();
    expect(metrics).toContain(`llm_cache_observations_total{${dimensions},coverage="known"} 2`);
    expect(metrics).toContain(`llm_cache_observations_total{${dimensions},coverage="cache_unknown"} 1`);
    expect(metrics).toContain(`llm_cache_observations_total{${dimensions},coverage="input_unknown"} 1`);
    expect(metrics).toContain(`llm_cache_tokens_total{${dimensions},kind="covered_input"} 1000`);
    expect(metrics).toContain(`llm_cache_tokens_total{${dimensions},kind="read"} 600`);
    expect(metrics).toContain(`llm_cache_tokens_total{${dimensions},kind="observed_input"} 1100`);
    expect(metrics).toContain(`llm_cache_tokens_total{${dimensions},kind="write"} 100`);
    // Compatibility aggregate still has every reported prompt and cache token.
    expect(metrics).toContain(`llm_tokens_total{usage="${usage}",kind="prompt"} 1600`);
    expect(metrics).toContain(`llm_tokens_total{usage="${usage}",kind="cached"} 1000`);
  });

  it('separates actual model/path dimensions and does not turn errors or legacy input into observed misses', () => {
    initLlmMetrics();
    const usage = 'cache_route_fixture';
    for (const [model, transportPath] of [['model-a', 'openai_json'], ['model-b', 'anthropic_json']] as const) {
      emitLlmResult(usage, { content: '', label: 'same-provider', model, transportPath, latencyMs: 1,
        tokenUsage: { prompt: 100, completion: 1, total: 101, cached: 50, inputKnown: true } });
    }
    emitLlmResult(usage, { content: '', label: 'legacy-provider', model: 'legacy', latencyMs: 1,
      tokenUsage: { prompt: 100, completion: 1, total: 101, cached: 0 } });
    emitLlmError(usage, 'failed-provider', 'failed');
    const metrics = renderMetrics();
    expect(metrics).toContain(`llm_cache_tokens_total{usage="${usage}",label="same-provider",model="model-a",path="openai_json",kind="read"} 50`);
    expect(metrics).toContain(`llm_cache_tokens_total{usage="${usage}",label="same-provider",model="model-b",path="anthropic_json",kind="read"} 50`);
    expect(metrics).toContain(`llm_cache_observations_total{usage="${usage}",label="legacy-provider",model="legacy",path="unknown",coverage="input_unknown"} 1`);
    expect(metrics).not.toContain(`llm_cache_observations_total{usage="${usage}",label="failed-provider"`);
  });

  it('rejects invalid counts and prevents arbitrary URL/secret/text metric dimensions', () => {
    initLlmMetrics();
    const captured: LlmResultEvent[] = [];
    const listener = (event: LlmResultEvent) => captured.push(event);
    llmEvents.on('result', listener);
    try {
      emitLlmResult('https://invalid.example', {
        content: 'SYNTHETIC_PRIVATE_BODY', model: 'sk-synthetic-private-value', label: 'Bearer fake',
        latencyMs: 1, transportPath: 'unexpected-private-path' as AICallResult['transportPath'],
        tokenUsage: { prompt: 100, completion: 1, total: 101, cached: Number.NaN,
          cacheWrite: -1, inputKnown: true },
      });
    } finally { llmEvents.off('result', listener); }
    const event = captured[0]!;
    expect(event).toMatchObject({ usage: 'unknown', model: 'unknown', label: 'unknown', inputKnown: true });
    expect(event.cachedTokens).toBeUndefined();
    expect(event.cacheWriteTokens).toBeUndefined();
    expect(event.transportPath).toBeUndefined();
    const metrics = renderMetrics();
    expect(metrics).not.toContain('invalid.example');
    expect(metrics).not.toContain('sk-synthetic-private-value');
    expect(metrics).not.toContain('unexpected-private-path');
    expect(metrics).not.toContain('SYNTHETIC_PRIVATE_BODY');
  });
});
