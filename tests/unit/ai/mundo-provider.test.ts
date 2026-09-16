import { beforeEach, describe, expect, it, vi } from 'vitest';

// 可变 env + providers:含一个 insecureTLS 的 mundo 供应商 + 一个普通供应商。
const envValues: Record<string, unknown> = { MUNDO_ENABLED: true };
const MOCK_PROVIDERS = new Map<string, Record<string, unknown>>([
  ['mundo', { name: 'mundo', endpoint: 'https://10.0.0.1:9/v1', apiKey: 'k', model: 'qwen3.6', insecureTLS: true }],
  ['stepfun', { name: 'stepfun', endpoint: 'https://api.stepfun.example/v1', apiKey: 'k2', model: 'step-3.7-flash' }],
]);

vi.mock('../../../src/env.js', () => ({
  env: () => envValues,
  getProviders: () => MOCK_PROVIDERS,
  getReplyMaxLabels: () => [] as string[],
  getUsageRouting: () => new Map(),
}));

import { _resetLabels, getLabels, getUsage } from '../../../src/ai/labels.js';

describe('Mundo 部门可开可不开', () => {
  beforeEach(() => { _resetLabels(); });

  it('MUNDO_ENABLED=true → 注册 mundo label,且 insecureTLS 只落在 mundo 上', () => {
    envValues['MUNDO_ENABLED'] = true;
    const labels = getLabels();
    expect(labels.has('mundo')).toBe(true);
    expect(labels.get('mundo')?.insecureTLS).toBe(true);
    // TLS 跳过严格限定:兜底 stepfun 绝不能被污染
    expect(labels.get('stepfun')?.insecureTLS).toBeFalsy();
  });

  it('MUNDO_ENABLED=false → 不注册 mundo label(零足迹)', () => {
    envValues['MUNDO_ENABLED'] = false;
    const labels = getLabels();
    expect(labels.has('mundo')).toBe(false);
    // 其它供应商不受影响
    expect(labels.has('stepfun')).toBe(true);
  });

  it('mundo usage:label=mundo,兜底 stepfun,大 maxTokens + 长 timeout', () => {
    envValues['MUNDO_ENABLED'] = true;
    _resetLabels();
    const u = getUsage('mundo');
    expect(u.label).toBe('mundo');
    expect(u.backups).toContain('stepfun');
    expect(u.maxTokens).toBeGreaterThanOrEqual(8000);
    expect(u.timeout).toBeGreaterThanOrEqual(120_000);
  });

  it('MUNDO_ENABLED=false 时路由到 mundo → 响亮报错(label 缺失,不静默走禁用端点)', () => {
    envValues['MUNDO_ENABLED'] = false;
    _resetLabels();
    expect(() => getUsage('mundo')).toThrow();
  });
});
