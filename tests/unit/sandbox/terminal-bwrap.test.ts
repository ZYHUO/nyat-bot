import { describe, expect, it, vi } from 'vitest';

// bwrap 隔离的单测: 参数构造(纯函数) + 真机隔离断言(有 bwrap 才跑)。
// env() mock 必须带 SANDBOX_BWRAP_ENABLED, 否则 bwrapAvailable 走 catch→true。
vi.mock('../../../src/env.js', () => ({
  env: () => ({
    SANDBOX_ALLOWED_COMMANDS: '',
    SANDBOX_BLOCKED_COMMANDS: '',
    CODEACT_TIMEOUT_MS: 10_000,
    SANDBOX_TERMINAL_ENABLED: true,
    SANDBOX_BWRAP_ENABLED: true,
  }),
}));

import { existsSync } from 'node:fs';
import { buildBwrapSpec, executeCommand } from '../../../src/sandbox/terminal.js';

const HAS_BWRAP = existsSync('/usr/bin/bwrap');

describe('buildBwrapSpec', () => {
  it('binds only the sandbox cwd writable, isolates namespaces', () => {
    const spec = buildBwrapSpec('echo hi', '/tmp/sb-test', 5000);
    expect(spec.bin).toBe('/usr/bin/bwrap');
    expect(spec.args).toContain('--unshare-all');
    expect(spec.args).toContain('--die-with-parent');
    // 只读绑定系统目录
    const roIdx = spec.args.indexOf('--ro-bind');
    expect(spec.args[roIdx + 1]).toBe('/usr');
    // 宿主 cwd 绑到沙盒内 /sandbox(唯一 --bind 可写), chdir 到 /sandbox
    const binds: string[] = [];
    spec.args.forEach((a, i) => { if (a === '--bind') binds.push(`${spec.args[i + 1]}→${spec.args[i + 2]}`); });
    expect(binds).toEqual(['/tmp/sb-test→/sandbox']);
    expect(spec.args).toContain('/sandbox');
    // 命令走 -- 后 /bin/sh -c
    const dash = spec.args.indexOf('--');
    expect(spec.args.slice(dash + 1)).toEqual(['/bin/sh', '-c', 'echo hi']);
  });
});

describe('executeCommand isolation (live bwrap)', () => {
  it.skipIf(!HAS_BWRAP)('sees an empty /root and cannot read host .env', async () => {
    // 沙盒内 /root 不存在(没绑定) → ls 失败; 宿主 /root/xxb-ts/.env 不可读
    const r1 = await executeCommand('ls /root 2>&1; echo LS_EXIT:$?');
    expect(r1.stdout).toContain('LS_EXIT:2');
    const r2 = await executeCommand('cat /root/xxb-ts/.env 2>&1; echo CAT_EXIT:$?');
    expect(r2.stdout).toContain('CAT_EXIT:1');
  });

  it.skipIf(!HAS_BWRAP)('has no network and isolated pid 1', async () => {
    const r = await executeCommand('cat /proc/1/cmdline 2>/dev/null | tr "\\0" " "; echo; echo PID:$$');
    // 沙盒内 PID 命名空间: $$ 应该是小数字(非宿主 pid)
    const m = r.stdout.match(/PID:(\d+)/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeLessThan(100);
  });

  it.skipIf(!HAS_BWRAP)('cwd is writable, python3 works', async () => {
    const r = await executeCommand('echo hello > iso-probe.txt && cat iso-probe.txt && python3 -c "print(1+1)" && rm iso-probe.txt');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('hello');
    expect(r.stdout).toContain('2');
  });

  it('dangerous patterns still blocked before bwrap', async () => {
    const r = await executeCommand('rm -rf /tmp/should-not-run');
    expect(r.exitCode).toBe(-1);
    expect(r.stderr).toContain('blocked by sandbox policy');
  });
});
