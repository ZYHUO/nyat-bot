import { exec, execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { env } from '../env.js';
import { resolveSandboxRoot } from './paths.js';
import { logger } from '../shared/logger.js';

const MAX_OUTPUT = 4000;

// ── 真隔离: bwrap userns 沙盒(Phase 15) ──
// executeCommand 默认走 bwrap: 与宿主隔离 mount/user/pid/net(无 lo 外网,
// 保留回环做本地 DNS 兜底),cwd=data/sandbox 以读写绑定,PATH/SSL 只读绑定。
// 降级: bwrap 二进制缺失或启动失败 → 走旧宿主 exec(纵深防御模式集仍先生效),
// 并打 warn 日志(上线后应为 0, 可按此报警)。
const BWRAP_BIN = '/usr/bin/bwrap';
let bwrapMissingLogged = false;

function bwrapAvailable(): boolean {
  // SANDBOX_BWRAP_ENABLED 默认 true; 运维可显式设 0 回退宿主执行(应急)。
  try {
    if (!env().SANDBOX_BWRAP_ENABLED) return false;
  } catch { return true; }
  if (existsSync(BWRAP_BIN)) return true;
  if (!bwrapMissingLogged) {
    bwrapMissingLogged = true;
    logger.warn('sandbox: bwrap binary missing, falling back to host exec (no isolation)');
  }
  return false;
}

interface BwrapSpec {
  bin: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
}

/** 构造 bwrap 启动参数: 命令走 /bin/sh -c(沙盒内), 环境只给最小集。
 * 关键: 不绑定宿主 / 等敏感目录 —— 沙盒内 / 只有绑进去的系统目录,
 * /root/.env 等一律不可见。cwd 是唯一可写绑定; 沙盒内 chdir 到 /sandbox。
 */
export function buildBwrapSpec(command: string, cwd: string, timeoutMs: number): BwrapSpec {
  const pathEnv = process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin';
  return {
    bin: BWRAP_BIN,
    args: [
      '--unshare-all',       // user/mount/pid/net/ipc/uts 全隔离
      '--die-with-parent',   // bot 崩了不留孤儿进程
      '--ro-bind', '/usr', '/usr',
      '--ro-bind-try', '/usr/local', '/usr/local',
      '--ro-bind', '/bin', '/bin',
      '--ro-bind', '/lib', '/lib',
      '--ro-bind', '/lib64', '/lib64',
      '--ro-bind-try', '/etc/ssl', '/etc/ssl',
      '--ro-bind-try', '/etc/ca-certificates', '/etc/ca-certificates',
      '--ro-bind-try', '/etc/resolv.conf', '/etc/resolv.conf',
      '--bind', cwd, '/sandbox', // 唯一可写绑定, 沙盒内固定 /sandbox
      '--dir', '/tmp',
      '--tmpfs', '/run',
      '--proc', '/proc',
      '--dev', '/dev',
      '--chdir', '/sandbox',
      '--setenv', 'PATH', pathEnv,
      '--setenv', 'HOME', '/sandbox',
      '--setenv', 'LANG', 'en_US.UTF-8',
      '--', '/bin/sh', '-c', command,
    ],
    cwd,
    timeoutMs,
  };
}

/**
 * P1 fix(2026-08-22 审查): 原实现是子串匹配——`rm -rf` 拦不住 `rm -r -f`/`rm -fr`/
 * `find . -delete`, 且 exec 走 /bin/sh -c, 反引号/$() 里的语义等价命令完全绕过。
 * 改为两层: ①归一化(小写+空白折叠)后的正则危险模式集 ②可选白名单优先。
 * 注意: 这仍是**纵深防御而非安全边界**——SANDBOX_TERMINAL_ENABLED=true 即模型可
 * 在宿主执行任意未被模式命中的命令(读 .env/curl 外带)。真隔离需要容器/uid。
 */
const DANGEROUS_COMMAND_PATTERNS: RegExp[] = [
  /\brm\b[^|;&]*\b(-[a-z]*[rf][a-z]*\s+)+/,   // rm 任意组合含 -r/-f (rm -r -f / rm -fr / rm -rf)
  /\brm\s+-[a-z]*r[a-z]*/,                        // rm 任何带 -r 的形式
  /\b(sh|bash|zsh|dash)\s+-c\b/,                 // 嵌套 shell(绕黑名单的载体)
  /\b(mkfs(\.\w+)?|halt|reboot|poweroff|shutdown|init\s+[06])\b/,
  /\bdd\b[^|;&]*\bof=/,                          // dd if=... of=磁盘
  /\bchmod\s+-?[a-z]*777/,                        // chmod 777(任意变体)
  /\b(chown|chmod)\b[^|;&]*\s\/($|\s)/,         // 对根路径改属/改权
  /\b>\s*\/(dev\/sd|dev\/nvme)/,                // 直写块设备
  /:\(\)\s*\{.*\};\s*:/,                       // fork bomb 经典体
  /\bcurl\b[^|;&]*\|\s*(sh|bash|zsh)/,           // curl | sh
  /\bwget\b[^|;&]*\|\s*(sh|bash|zsh)/,
  /\bfind\b[^|;&]*\s(-delete|-exec\s+(rm|sh))/,  // find -delete / -exec rm
  /\bxargs\b[^|;&]*\brm/,                         // xargs rm
  /\bmv\b[^|;&]*\s\/(dev|etc|usr|bin|sbin|boot)\b/,
  /\btruncate\b\s+-s\s*0/,                       // truncate 清空文件
];

function normalizeForMatch(command: string): string {
  return command.toLowerCase().replace(/\s+/g, ' ').trim();
}

export function isCommandAllowed(command: string): boolean {
  const normalized = normalizeForMatch(command);

  // 白名单优先(SANDBOX_ALLOWED_COMMANDS 非空时只放行命中项)
  const allowed = env().SANDBOX_ALLOWED_COMMANDS;
  if (allowed && allowed.trim()) {
    for (const a of allowed.split(',').map(s => s.trim().toLowerCase())) {
      if (a && normalized.includes(a)) return true;
    }
    return false;
  }

  // 危险模式集(子串黑名单的替代, 覆盖参数重排/拆分变体)
  for (const pattern of DANGEROUS_COMMAND_PATTERNS) {
    if (pattern.test(normalized)) return false;
  }

  // 兼容保留: SANDBOX_BLOCKED_COMMANDS 追加项仍按字面匹配(运维自定义扩展用)
  const blocked = env().SANDBOX_BLOCKED_COMMANDS;
  if (blocked) {
    for (const b of blocked.split(',').map(s => s.trim().toLowerCase())) {
      if (b && normalized.includes(b)) return false;
    }
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
    logger.warn({ command: command.slice(0, 120) }, 'sandbox terminal: dangerous command pattern blocked');
    return Promise.resolve({ stdout: '', stderr: 'command blocked by sandbox policy', exitCode: -1, durationMs: 0 });
  }
  const cwd = resolveSandboxRoot();
  const start = Date.now();
  // 真隔离优先: bwrap 沙盒内执行; 不可用/启动失败 → 降级宿主 exec(模式集已先生效)。
  if (bwrapAvailable()) {
    const spec = buildBwrapSpec(command, cwd, timeoutMs);
    return new Promise((resolve) => {
      const proc = execFile(spec.bin, spec.args, {
        cwd: spec.cwd,
        timeout: spec.timeoutMs,
        maxBuffer: 1024 * 1024,
      }, (err, stdout, stderr) => {
        const durationMs = Date.now() - start;
        if (err && (err as NodeJS.ErrnoException & { killed?: boolean }).killed) {
          resolve({ stdout: truncate(stdout), stderr: truncate(stderr) + '\n(timeout)', exitCode: -1, durationMs });
        } else if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
          logger.warn('sandbox: bwrap spawn ENOENT, falling back to host exec');
          resolve(hostExec(command, cwd, timeoutMs, start));
        } else {
          resolve({ stdout: truncate(stdout), stderr: truncate(stderr), exitCode: (err as { code?: number } | null)?.code ?? 0, durationMs });
        }
      });
      proc.on('error', () => {
        resolve({ stdout: '', stderr: 'spawn error', exitCode: -1, durationMs: Date.now() - start });
      });
    });
  }
  return hostExec(command, cwd, timeoutMs, start);
}

/** 降级路径: 宿主 exec(无隔离, 仅纵深防御模式集)。bwrap 缺失/禁用/启动失败时用。 */
function hostExec(command: string, cwd: string, timeoutMs: number, start: number): Promise<CommandResult> {
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

function truncate(str: string): string {
  return str.length > MAX_OUTPUT ? str.slice(0, MAX_OUTPUT) + '\n... (truncated)' : str;
}

/** Probe available runtimes in the sandbox (python3/go/node). Never throws. */
export async function getSandboxEnvInfo(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [name, cmd] of [
    ['python3', 'python3 --version'],
    ['go', 'go version'],
    ['node', 'node --version'],
  ] as const) {
    try {
      const r = await executeCommand(cmd, { timeoutMs: 5000 });
      out[name] = r.exitCode === 0 ? r.stdout.trim().split('\n')[0] ?? 'available' : `unavailable (${r.stderr.trim().slice(0, 60) || 'not found'})`;
    } catch {
      out[name] = 'unavailable';
    }
  }
  return out;
}
