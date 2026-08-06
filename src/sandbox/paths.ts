import { mkdirSync } from 'node:fs';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { env } from '../env.js';

export function sandboxEnabled(): boolean {
  return env().SANDBOX_ENABLED;
}

export function resolveSandboxRoot(): string {
  const root = resolve(process.cwd(), 'data/sandbox');
  mkdirSync(root, { recursive: true });
  return root;
}

export function resolveScreenshotDir(): string {
  const dir = join(resolveSandboxRoot(), 'screenshots');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Resolve a path inside the sandbox, rejecting path traversal escapes. */
export function resolveInsideSandbox(rel: string): string {
  const root = resolveSandboxRoot();
  const target = isAbsolute(rel) ? resolve(rel) : resolve(root, rel);
  const rel2 = relative(root, target);
  if (rel2.startsWith('..') || isAbsolute(rel2)) {
    throw new Error(`path_escape: ${rel} resolves outside sandbox`);
  }
  return target;
}
