import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type AcceptanceCheck =
  | { kind: 'nonempty_file'; path: string }
  | { kind: 'json_field'; path: string; field: string[]; equals: Json }
  | { kind: 'sha256'; path: string; equals: string };
export interface AcceptanceContract { source: 'caller' | 'model'; checks: AcceptanceCheck[] }
export interface AcceptanceResult {
  status: 'verified' | 'failed' | 'unverified';
  reasons: string[];
  checks: { index: number; ok: boolean; reason: string }[];
}
const MAX_BYTES = 1024 * 1024;

/** Read bounded regular files only. This is not containment of a hostile host process. */
async function readArtifact(root: string, name: string): Promise<Buffer> {
  if (!name || name.includes('\0') || isAbsolute(name)) throw new Error('invalid_path');
  const base = await realpath(root);
  const target = resolve(base, name);
  const rel = relative(base, target);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('path_escape');
  let part = base;
  for (const component of rel.split(sep)) {
    part = resolve(part, component);
    if ((await lstat(part)).isSymbolicLink()) throw new Error('symlink_rejected');
  }
  if (await realpath(target) !== target) throw new Error('path_changed');
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES || stat.nlink !== 1) throw new Error('invalid_file');
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await handle.read(bytes, size, bytes.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > MAX_BYTES) throw new Error('file_too_large');
    return bytes.subarray(0, size);
  } finally { await handle.close(); }
}

export async function validateAcceptance(root: string, contract?: AcceptanceContract): Promise<AcceptanceResult> {
  if (!contract) return { status: 'unverified', reasons: ['no_contract'], checks: [] };
  if (!['caller', 'model'].includes(contract.source) || !Array.isArray(contract.checks) || contract.checks.length > 8) {
    return { status: 'failed', reasons: ['invalid_contract'], checks: [] };
  }
  if (!contract.checks.length) return { status: 'unverified', reasons: ['empty_contract'], checks: [] };
  const checks: AcceptanceResult['checks'] = [];
  for (const [index, check] of contract.checks.entries()) {
    let ok = false;
    try {
      if (!check || typeof check.path !== 'string' || check.path.length > 512) throw new Error('invalid_check');
      const data = await readArtifact(root, check.path);
      if (check.kind === 'nonempty_file') ok = data.length > 0;
      else if (check.kind === 'sha256') {
        ok = typeof check.equals === 'string' && /^[a-f0-9]{64}$/i.test(check.equals) &&
          createHash('sha256').update(data).digest('hex') === check.equals.toLowerCase();
      } else if (check.kind === 'json_field') {
        if (!Array.isArray(check.field) || check.field.length > 20 || !check.field.every((k) => typeof k === 'string' && k.length < 256) || !Object.hasOwn(check, 'equals')) throw new Error('invalid_field');
        let value: unknown = JSON.parse(data.toString('utf8'));
        for (const key of check.field) {
          if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) throw new Error('missing_field');
          value = (value as Record<string, unknown>)[key];
        }
        ok = isDeepStrictEqual(value, check.equals);
      }
    } catch { /* Fail closed without disclosing filesystem paths or file contents. */ }
    checks.push({ index, ok, reason: ok ? 'check_passed' : 'check_failed' });
  }
  if (checks.some((c) => !c.ok)) return { status: 'failed', reasons: ['acceptance_check_failed'], checks };
  return { status: contract.source === 'caller' ? 'verified' : 'unverified',
    reasons: [contract.source === 'caller' ? 'caller_checks_passed' : 'model_checks_not_independent'], checks };
}
