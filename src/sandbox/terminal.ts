import { exec } from 'node:child_process';
import { env } from '../env.js';
import { resolveSandboxRoot } from './paths.js';

const MAX_OUTPUT = 4000;

export function isCommandAllowed(command: string): boolean {
  const blocked = env().SANDBOX_BLOCKED_COMMANDS;
  if (blocked) {
    const lower = command.toLowerCase();
    for (const b of blocked.split(',').map(s => s.trim().toLowerCase())) {
      if (b && lower.includes(b)) return false;
    }
  }
  const allowed = env().SANDBOX_ALLOWED_COMMANDS;
  if (allowed && allowed.trim()) {
    const lower = command.toLowerCase();
    for (const a of allowed.split(',').map(s => s.trim().toLowerCase())) {
      if (a && lower.includes(a)) return true;
    }
    return false;
  }
  return true;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

export function executeCommand(command: string, opts?: { timeoutMs?: number }): Promise<CommandResult> {
  const timeoutMs = opts?.timeoutMs ?? env().CODEACT_TIMEOUT_MS;
  if (!env().SANDBOX_TERMINAL_ENABLED) {
    return Promise.resolve({ stdout: '', stderr: 'terminal disabled', exitCode: -1, durationMs: 0 });
  }
  if (!isCommandAllowed(command)) {
    return Promise.resolve({ stdout: '', stderr: 'command blocked by sandbox policy', exitCode: -1, durationMs: 0 });
  }
  const cwd = resolveSandboxRoot();
  const start = Date.now();
  return new Promise((resolve) => {
    const proc = exec(command, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      env: { PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin', HOME: cwd, LANG: 'en_US.UTF-8' },
    }, (err, stdout, stderr) => {
      const durationMs = Date.now() - start;
      if (err && err.killed) {
        resolve({ stdout: truncate(stdout), stderr: truncate(stderr) + '\n(timeout)', exitCode: -1, durationMs });
      } else {
        resolve({ stdout: truncate(stdout), stderr: truncate(stderr), exitCode: err?.code ?? 0, durationMs });
      }
    });
    proc.on('error', () => {
      resolve({ stdout: '', stderr: 'spawn error', exitCode: -1, durationMs: Date.now() - start });
    });
  });
}

function truncate(s: string | Buffer): string {
  const str = typeof s === 'string' ? s : s.toString('utf8');
  return str.length > MAX_OUTPUT ? str.slice(0, MAX_OUTPUT) + '\n... (truncated)' : str;
}
