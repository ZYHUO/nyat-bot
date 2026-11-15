import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { syntheticAiConfig } from '../../helpers/synthetic-ai-config.js';

afterEach(() => vi.unstubAllEnvs());
describe('reflection and judge account isolation configuration', () => {
  it('uses real routing for the independent background account', async () => {
    const config = await syntheticAiConfig();
    expect(config.getUsage('reflection').label).toBe('lfree');
    expect(config.getUsage('judge').label).toBe('stepfun');
    expect(config.audit()).toEqual([]);
  });
  it('rejects different label names pointing at the same account', async () => {
    const config = await syntheticAiConfig({ AI_USAGE_REFLECTION_LABEL: 'stepfunjudge' });
    expect(config.getUsage('reflection').label).not.toBe(config.getUsage('judge').label);
    expect(config.audit()).toContain('reflection_shares_judge_account');
  });
  it('rejects a missing reflection provider rather than silently calling judge', async () => {
    const config = await syntheticAiConfig({ AI_USAGE_REFLECTION_LABEL: 'deleted_provider' });
    expect(() => config.getUsage('reflection')).toThrow('references missing label');
    expect(config.audit()).toContain('usage_invalid:reflection');
  });
  it('keeps the public configuration and bounded serial reflection call site', () => {
    expect(readFileSync('.env.example', 'utf8')).toMatch(/AI_USAGE_REFLECTION_LABEL=/);
    const source = readFileSync('src/cron/deep-reflection.ts', 'utf8');
    expect(source).toContain('waitIfCooling: true');
    expect(source).toContain('for (const chatId of chatIds) {');
    expect(source).toContain('const r = await reflectChat(chatId)');
  });
});
