import { describe, it, expect } from 'vitest';
import { incrCounter, renderMetrics } from '../../../src/metrics/registry.js';

describe('metrics registry', () => {
  it('accumulates labelled counters and renders Prometheus text', () => {
    incrCounter('llm_requests_total', { usage: 'reply', label: 'deepseek' });
    incrCounter('llm_requests_total', { usage: 'reply', label: 'deepseek' });
    incrCounter('llm_tokens_total', { usage: 'reply', kind: 'prompt' }, 1500);
    const out = renderMetrics();
    expect(out).toContain('# TYPE llm_requests_total counter');
    expect(out).toContain('llm_requests_total{usage="reply",label="deepseek"} 2');
    expect(out).toContain('llm_tokens_total{usage="reply",kind="prompt"} 1500');
  });

  it('sanitizes label values (no quote/newline injection)', () => {
    incrCounter('test_metric', { label: 'a"b\nc' });
    const out = renderMetrics();
    expect(out).toContain('test_metric{label="abc"} 1');
  });
});
