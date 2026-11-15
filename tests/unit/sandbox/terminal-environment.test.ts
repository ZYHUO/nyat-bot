import { afterEach, describe, expect, it, vi } from 'vitest';
import { tmpdir } from 'node:os';
import type { ExecFileException, ExecFileOptions } from 'node:child_process';

vi.mock('../../../src/env.js', () => ({ env: () => ({
  SANDBOX_ALLOWED_COMMANDS: '', SANDBOX_BLOCKED_COMMANDS: '',
  CODEACT_TIMEOUT_MS: 5000, SANDBOX_TERMINAL_ENABLED: true,
  SANDBOX_BWRAP_ENABLED: true, SANDBOX_REQUIRE_ISOLATION: true,
}) }));
vi.mock('../../../src/sandbox/paths.js', () => ({ resolveSandboxRoot: () => tmpdir() }));
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, existsSync: (path: Parameters<typeof actual.existsSync>[0]) => path === '/usr/bin/bwrap' || actual.existsSync(path) };
});
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFile: (file: string, _args: string[], options: ExecFileOptions, callback: (error: ExecFileException | null, stdout: string, stderr: string) => void) => {
    if (file !== '/usr/bin/bwrap') throw new Error('unexpected child executable');
    // Run a real harmless child through executeCommand's spawn options. This is
    // portable environment-boundary coverage, not a fake namespace-isolation test.
    return actual.execFile(process.execPath, ['-e', 'process.stdout.write(JSON.stringify({canary:process.env.NYATBOT_FAKE_SECRET_CANARY??null,home:process.env.HOME}))'], {
      ...options, cwd: tmpdir(), encoding: 'utf8',
    }, callback);
  } };
});

import { executeCommand } from '../../../src/sandbox/terminal.js';
afterEach(() => vi.unstubAllEnvs());

describe('terminal production spawn environment', () => {
  it('passes the whitelist to the actual child process instead of inheriting the host', async () => {
    vi.stubEnv('NYATBOT_FAKE_SECRET_CANARY', 'synthetic-never-forward');
    const result = await executeCommand('env');
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ canary: null, home: '/sandbox' });
    expect(result.stderr).not.toContain('synthetic-never-forward');
  });
});
