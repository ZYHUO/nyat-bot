import { describe, expect, it, vi } from 'vitest';
import { codeActLaunchArgs } from '../../../src/sandbox/codeact/profile.js';
import { codeActSeccompFilter } from '../../../src/sandbox/codeact/seccomp.js';
import { packCodeActValue, unpackCodeActValue } from '../../../src/sandbox/codeact/capabilities.js';
import { executeIsolatedCode, runCodeActSandbox } from '../../../src/sandbox/codeact/runner.js';

vi.mock('../../../src/env.js', () => ({ env: () => ({ CODEACT_ISOLATION_ENABLED: false }) }));
const profile = { bwrapPath: '/missing-codeact-bwrap', prlimitPath: '/usr/bin/prlimit', nodePath: '/test/node', runtimeFiles: ['/test/libc.so.6'] };

function decision(nr: number, flags = 0, arch = 0xc000003e): number {
  const bpf = codeActSeccompFilter();
  let accumulator = 0;
  for (let pc = 0; pc < bpf.length / 8; pc++) {
    const code = bpf.readUInt16LE(pc * 8), jt = bpf[pc * 8 + 2]!, jf = bpf[pc * 8 + 3]!, k = bpf.readUInt32LE(pc * 8 + 4);
    if (code === 0x20) accumulator = k === 0 ? nr : k === 4 ? arch : flags;
    else if (code === 0x15) pc += accumulator === k ? jt : jf;
    else if (code === 0x35) pc += accumulator >= k ? jt : jf;
    else if (code === 0x45) pc += (accumulator & k) !== 0 ? jt : jf;
    else if (code === 0x06) return k;
    else throw new Error('Unexpected BPF instruction');
  }
  throw new Error('BPF fell through');
}

describe('fixed CodeAct isolation policy', () => {
  it('includes hard limits, read-only exact files, seccomp and namespace isolation', () => {
    const args = codeActLaunchArgs(profile, false);
    for (const required of ['--as=536870912:536870912', '--cpu=3:3', '--nproc=256:256', '--fsize=0:0',
      '--unshare-user', '--unshare-pid', '--unshare-net', '--clearenv', '--seccomp', '--remount-ro']) expect(args).toContain(required);
    expect(args).not.toContain('--share-net');
    expect(args).not.toContain('--bind');
    expect(args).not.toContain('--ro-bind-try');
    expect(args).not.toContain('/usr');
    expect(args).not.toContain('/etc');
  });

  it('root test mode grants only bootstrap identity-drop capabilities', () => {
    const args = codeActLaunchArgs(profile, true);
    expect(args).not.toContain('--unshare-user');
    expect(args.filter((_, i) => args[i - 1] === '--cap-add')).toEqual(['CAP_SETUID', 'CAP_SETGID']);
    expect(args).toContain('--cap-drop');
  });

  it('rejects other syscall ABIs', () => {
    expect(decision(0, 0, 0x40000003)).toBe(0);
    expect(decision(0x40000000)).toBe(0);
  });

  it('denies sockets, process forks, namespace changes and shared-memory allocations', () => {
    for (const syscall of [29, 41, 53, 57, 58, 101, 165, 272, 308, 319, 321, 425]) {
      expect(decision(syscall)).toBe(0x00050001);
    }
    expect(decision(435)).toBe(0x00050026);
    expect(decision(56, 0)).toBe(0x00050001);
    expect(decision(56, 0x10000)).toBe(0x7fff0000);
    expect(decision(0)).toBe(0x7fff0000);
  });

  it('does not run code or host actions when disabled or runtime files are absent', async () => {
    const action = vi.fn();
    const capabilities = new Map([['test.action', action]]);
    await expect(executeIsolatedCode('await test.action()', capabilities, { timeoutMs: 1000 })).rejects.toThrow('disabled');
    await expect(runCodeActSandbox(profile, 'await test.action()', capabilities, { timeoutMs: 1000 })).rejects.toThrow();
    expect(action).not.toHaveBeenCalled();
  });

  it('serializes acknowledgements without transferring host functions', () => {
    const value = { messageId: 12, [Symbol.toPrimitive]: () => 'sent#12' };
    const wire = packCodeActValue(value);
    expect(wire).toEqual({ kind: 'json', value: { messageId: 12 }, display: 'sent#12' });
    expect(String(unpackCodeActValue(wire))).toBe('sent#12');
    expect(unpackCodeActValue(packCodeActValue(undefined))).toBeUndefined();
  });

  it('rejects oversized or cyclic host responses', () => {
    expect(() => packCodeActValue('x'.repeat(70_000))).toThrow('too_large');
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => packCodeActValue(cyclic)).toThrow();
  });
});
