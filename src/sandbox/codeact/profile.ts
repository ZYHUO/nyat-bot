import { open, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, normalize } from 'node:path';
import { CODEACT_GUEST_SOURCE } from './guest.js';

export interface CodeActProfile {
  bwrapPath: string;
  prlimitPath: string;
  nodePath: string;
  /** Exact trusted ELF dependencies, never directories or application files. */
  runtimeFiles: readonly string[];
}

export async function validateCodeActProfile(profile: CodeActProfile): Promise<void> {
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('codeact_isolation_requires_linux_x64');
  if (!profile.runtimeFiles.length || profile.runtimeFiles.length > 32) throw new Error('codeact_runtime_manifest_required');
  const executables = new Set([profile.bwrapPath, profile.prlimitPath, profile.nodePath]);
  for (const file of [...executables, ...profile.runtimeFiles]) {
    if (!isAbsolute(file) || normalize(file) !== file || /[\r\n\0]/.test(file)) throw new Error('invalid_codeact_runtime_path');
    if (!executables.has(file) && !/^(?:lib[^/]+|ld[^/]*)\.so(?:\.[^/]+)*$/.test(basename(file))) {
      throw new Error('codeact_manifest_only_allows_libraries');
    }
    const resolved = await realpath(file);
    const info = await stat(resolved);
    if (!info.isFile() || (info.mode & 0o022) !== 0 || (info.mode & 0o6000) !== 0) {
      throw new Error('codeact_runtime_must_be_regular_non_writable_non_setid');
    }
    if (info.uid !== 0 && info.uid !== process.getuid?.()) throw new Error('codeact_runtime_owner_untrusted');
    const handle = await open(resolved, 'r');
    try {
      const magic = Buffer.alloc(4);
      await handle.read(magic, 0, 4, 0);
      if (!magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) throw new Error('codeact_runtime_must_be_elf');
    } finally { await handle.close(); }
  }
}

/** Fixed launcher policy. No command, environment, mount, uid or flag comes from model code. */
export function codeActLaunchArgs(profile: CodeActProfile, privileged: boolean): string[] {
  const args = [
    // RLIMIT_NPROC counts every thread owned by the host UID, including the
    // bot's ONNX pool. 32 prevented namespace creation on a healthy 67-thread
    // service. Keep a finite per-UID ceiling with room for the single guest;
    // seccomp still rejects process forks and new namespaces inside the guest.
    '--as=536870912:536870912', '--cpu=3:3', '--nproc=256:256', '--nofile=64:64', '--fsize=0:0', '--core=0:0',
    '--', profile.bwrapPath,
    '--unshare-pid', '--unshare-net', '--unshare-ipc', '--unshare-uts',
    '--die-with-parent', '--new-session', '--clearenv', '--cap-drop', 'ALL',
  ];
  if (privileged) {
    // Only the fixed bootstrap can read stdin before dropping these to uid/gid
    // 65534. It verifies effective/permitted capabilities are zero before READY.
    args.push('--cap-add', 'CAP_SETUID', '--cap-add', 'CAP_SETGID');
  } else {
    args.push('--unshare-user', '--uid', '65534', '--gid', '65534');
  }
  for (const file of new Set([profile.nodePath, ...profile.runtimeFiles])) args.push('--ro-bind', file, file);
  args.push('--proc', '/proc', '--remount-ro', '/proc',
    '--dev-bind', '/dev/null', '/dev/null', '--dev-bind', '/dev/urandom', '/dev/urandom',
    '--dir', '/tmp', '--chdir', '/', '--setenv', 'LANG', 'C.UTF-8', '--setenv', 'TZ', 'UTC',
    '--remount-ro', '/', '--seccomp', '3', '--', profile.nodePath,
    '--jitless', '--no-expose-wasm', '--max-old-space-size=64', '--input-type=commonjs', '--eval', CODEACT_GUEST_SOURCE);
  return args;
}
