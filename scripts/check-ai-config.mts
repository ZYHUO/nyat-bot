import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'dotenv';
import { auditAiConfig } from './lib/ai-config-check.js';

// Explicit operator input only. Never infer production settings from cwd .env.
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--env' || !args[1]) {
  process.stderr.write('Usage: check-ai-config.mts --env <explicit-config-file>\n');
  process.exitCode = 2;
} else {
  try {
    const path = resolve(args[1]);
    const selected = parse(readFileSync(path, 'utf8'));
    for (const key of Object.keys(process.env)) {
      if (/^(AI_|LOCAL_AI_|CLAUDE_|REPLY_BACKUP|MUNDO_)/.test(key)) delete process.env[key];
    }
    Object.assign(process.env, selected);
    process.env.DOTENV_CONFIG_PATH = path;
    // Only now may env.ts load dotenv/config, from that same explicit input.
    const [{ parseEnv }, routing] = await Promise.all([import('../src/env.js'), import('../src/ai/labels.js')]);
    const issues = auditAiConfig({ labels: routing.getLabels(), usage: routing.getUsage,
      usageNames: routing.USAGE_NAMES, settings: parseEnv(selected) });
    process.stdout.write(JSON.stringify({ ok: issues.length === 0, issues, scope: 'configuration-only; no provider health or upstream quota proof' }) + '\n');
    process.exitCode = issues.length ? 1 : 0;
  } catch {
    process.stdout.write(JSON.stringify({ ok: false, issues: ['configuration_input_invalid'] }) + '\n');
    process.exitCode = 1;
  }
}
