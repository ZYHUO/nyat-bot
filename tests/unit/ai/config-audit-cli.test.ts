import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, dirname, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { syntheticAiConfig } from '../../helpers/synthetic-ai-config.js';

const script = resolve('scripts/check-ai-config.mts');
const loader = pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href;
const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) {
    if (dirname(resolve(dir)) !== resolve(tmpdir()) || !basename(dir).startsWith('nyat-ai-config-')) throw new Error('invalid_test_cleanup_path');
    rmSync(dir, { recursive: true, force: true });
  }
});
describe('explicit safe AI configuration audit CLI', () => {
  it('requires an explicit input, audits it without cwd dotenv, and never prints credentials', async () => {
    const fixture = await syntheticAiConfig();
    const dir = mkdtempSync(join(tmpdir(), 'nyat-ai-config-')); dirs.push(dir);
    writeFileSync(join(dir, '.env'), 'BOT_TOKEN=private-cwd-sentinel\nAI_USAGE_JUDGE_LABEL=wrong-cwd-value\n');
    const configPath = join(dir, 'candidate.env');
    writeFileSync(configPath, Object.entries(fixture.values).filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n'));
    const run = (args: string[]) => spawnSync(process.execPath, ['--import', loader, script, ...args],
      { cwd: dir, env: { ...process.env }, encoding: 'utf8', timeout: 20_000 });
    const missing = run([]);
    expect(missing.status).toBe(2); expect(missing.stderr).toContain('--env');
    const result = run(['--env', configPath]);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, issues: [] });
    expect(result.stdout).not.toMatch(/synthetic-shared-key|private-cwd-sentinel|12345:synthetic/);
    writeFileSync(configPath, '\nAI_USAGE_JUDGE_BACKUPS=deleted_provider\n', { flag: 'a' });
    const invalid = run(['--env', configPath]);
    expect(invalid.status).toBe(1);
    expect(JSON.parse(invalid.stdout).issues).toContain('usage_invalid:judge');
    expect(invalid.stdout).not.toContain('synthetic-shared-key');
  }, 60_000);
});
