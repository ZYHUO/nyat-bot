import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { syntheticAiConfig } from '../../helpers/synthetic-ai-config.js';

afterEach(() => vi.unstubAllEnvs());
describe('judge account fallback configuration (synthetic input, real routing)', () => {
  it('parses quoted backups in order and keeps a configured independent fallback', async () => {
    const config = await syntheticAiConfig();
    expect(config.getUsage('judge').backups).toEqual(['stepfunjudge', 'lfree']);
    expect(config.audit()).toEqual([]);
  });
  it('rejects a lone primary and aliases sharing its endpoint/key', async () => {
    expect((await syntheticAiConfig({ AI_USAGE_JUDGE_BACKUPS: '' })).audit()).toContain('judge_backup_missing');
    const config = await syntheticAiConfig({ AI_USAGE_JUDGE_BACKUPS: 'lfree',
      AI_PROVIDER_LFREE_ENDPOINT: 'https://primary.invalid/v1', AI_PROVIDER_LFREE_KEY: 'synthetic-shared-key' });
    expect(config.getUsage('judge').backups).toEqual(['lfree']);
    expect(config.audit()).toContain('judge_independent_account_missing');
  });
  it('detects same-account fallbacks placed after the independent fallback', async () => {
    expect((await syntheticAiConfig({ AI_USAGE_JUDGE_BACKUPS: 'lfree,stepfunjudge' })).audit()).toContain('judge_backup_order');
  });
  it('a fallback without a key/model does not count as usable configuration', async () => {
    expect((await syntheticAiConfig({ AI_PROVIDER_LFREE_KEY: '' })).audit()).toContain('provider_incomplete:lfree');
    const missingModel = await syntheticAiConfig({ AI_PROVIDER_LFREE_MODEL: '' });
    expect(() => missingModel.getUsage('judge')).toThrow('references missing label(s): lfree');
    expect(missingModel.audit()).toContain('usage_invalid:judge');
  });
  it('documents backups in the public example without requiring a private .env', () => {
    expect(readFileSync('.env.example', 'utf8')).toMatch(/AI_USAGE_JUDGE_BACKUPS=/);
  });
});
