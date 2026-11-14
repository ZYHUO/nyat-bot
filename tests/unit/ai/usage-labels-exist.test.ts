import { afterEach, describe, expect, it, vi } from 'vitest';
import { syntheticAiConfig } from '../../helpers/synthetic-ai-config.js';

afterEach(() => vi.unstubAllEnvs());
describe('every actual usage chain references registered providers', () => {
  it('checks the real default/override chains and enabled optional mundo route', async () => {
    const config = await syntheticAiConfig({ MUNDO_ENABLED: 'true' });
    const labels = config.getLabels();
    expect(config.USAGE_NAMES.length).toBeGreaterThan(5); expect(labels.size).toBeGreaterThan(0);
    for (const name of config.USAGE_NAMES) {
      const route = config.getUsage(name);
      expect([route.label, ...route.backups].filter(label => !labels.has(label)), name).toEqual([]);
    }
  });
  it('deleting a provider referenced by a default chain fails loud', async () => {
    const config = await syntheticAiConfig({ AI_PROVIDER_SPACEBUNNY_MODEL: undefined });
    expect(() => config.getUsage('reply_tools')).toThrow('references missing label(s): spacebunny');
    expect(config.audit()).toContain('usage_invalid:reply_tools');
  });
  it('deleting an overridden backup also fails instead of silently reducing resilience', async () => {
    const config = await syntheticAiConfig({ AI_USAGE_JUDGE_BACKUPS: 'deleted_provider' });
    expect(() => config.getUsage('judge')).toThrow('references missing label(s): deleted_provider');
  });
  it('disabled mundo is absent and a direct attempt to use it is rejected', async () => {
    const config = await syntheticAiConfig();
    expect(config.getLabels().has('mundo')).toBe(false);
    expect(() => config.getUsage('mundo')).toThrow('references missing label(s): mundo');
    expect(config.audit()).toEqual([]);
  });
});
