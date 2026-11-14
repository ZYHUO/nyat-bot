import { vi } from 'vitest';
import { parse } from 'dotenv';
import { auditAiConfig } from '../../scripts/lib/ai-config-check.js';

// Importing the real parsers must not load a developer or deployment .env.
vi.mock('dotenv/config', () => ({}));

/** All endpoints and keys below are synthetic. No provider/model API is called. */
export async function syntheticAiConfig(overrides: Record<string, string | undefined> = {}) {
  vi.resetModules();
  for (const name of Object.keys(process.env)) {
    if (/^(AI_|LOCAL_AI_|CLAUDE_|REPLY_BACKUP|MUNDO_)/.test(name)) vi.stubEnv(name, undefined);
  }
  const config = parse(`
BOT_TOKEN=12345:synthetic-config-only
MUNDO_ENABLED=false
TIMING_GATE_MAX_TOKENS=4000
ASI_RUBRIC_MAX_TOKENS=8000
AI_USAGE_JUDGE_LABEL=stepfun
AI_USAGE_JUDGE_BACKUPS="stepfunjudge, lfree"
AI_USAGE_SUMMARIZE_LABEL=stepfun
AI_USAGE_SUMMARIZE_BACKUPS=lfree
AI_USAGE_SUMMARIZE_MAX_TOKENS=8000
AI_USAGE_VISION_LABEL=stepfunvision
AI_USAGE_VISION_BACKUPS=lfree
AI_USAGE_VISION_MAX_TOKENS=16000
AI_USAGE_REFLECTION_LABEL=lfree
`);
  // Exercise the application's actual defaults too: deleting any referenced
  // provider below must make getUsage reject the default chain.
  for (const name of ['stepfun', 'stepfunjudge', 'stepfunvision', 'stepfunthink', 'step5', 'lfree', 'spacebunny', 'musespark', 'mimo', 'mundo']) {
    const up = name.toUpperCase();
    config[`AI_PROVIDER_${up}_ENDPOINT`] = name.startsWith('stepfun') ? 'https://primary.invalid/v1' : `https://${name}.invalid/v1`;
    config[`AI_PROVIDER_${up}_KEY`] = name.startsWith('stepfun') ? 'synthetic-shared-key' : `synthetic-${name}-key`;
    config[`AI_PROVIDER_${up}_MODEL`] = `synthetic-${name}-model`;
  }
  for (const [name, value] of Object.entries({ ...config, ...overrides })) vi.stubEnv(name, value);
  const environment = await import('../../src/env.js');
  const routing = await import('../../src/ai/labels.js');
  const audit = () => auditAiConfig({ labels: routing.getLabels(), usage: routing.getUsage,
    usageNames: routing.USAGE_NAMES, settings: environment.env() });
  return { ...environment, ...routing, audit, values: { ...config, ...overrides } };
}
