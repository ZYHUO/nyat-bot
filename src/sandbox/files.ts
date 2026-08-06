import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { resolveInsideSandbox, resolveSandboxRoot } from './paths.js';

const MAX_READ = 16_000;

/** Resolve an absolute path inside the sandbox for a relative one. */
export function resolveSandboxFile(rel: string): string {
  return resolveInsideSandbox(rel);
}

/** Relative-to-sandbox-root path (what the model should pass to sendFile). */
export function relToSandbox(abs: string): string {
  const root = resolveSandboxRoot();
  return relative(root, abs);
}

export async function sandboxReadFile(path: string): Promise<{ content: string }> {
  const target = resolveInsideSandbox(path);
  const content = await readFile(target, 'utf8');
  return { content: content.length > MAX_READ ? content.slice(0, MAX_READ) + '\n... (truncated)' : content };
}

export async function sandboxWriteFile(path: string, content: string): Promise<{ ok: boolean; path: string }> {
  const target = resolveInsideSandbox(path);
  // Ensure parent dir exists
  const lastSlash = target.lastIndexOf('/');
  if (lastSlash > 0) {
    await mkdir(target.slice(0, lastSlash), { recursive: true });
  }
  await writeFile(target, content, 'utf8');
  return { ok: true, path: relToSandbox(target) };
}

/** Binary-safe write (HTML/PNG/screenshot artifacts). Returns sandbox-relative path. */
export async function sandboxWriteBinary(path: string, buffer: Uint8Array): Promise<{ ok: boolean; path: string }> {
  const target = resolveInsideSandbox(path);
  const lastSlash = target.lastIndexOf('/');
  if (lastSlash > 0) {
    await mkdir(target.slice(0, lastSlash), { recursive: true });
  }
  await writeFile(target, buffer);
  return { ok: true, path: relToSandbox(target) };
}

export async function sandboxListFiles(dir?: string): Promise<{ files: string[] }> {
  const root = resolveSandboxRoot();
  const target = dir ? resolveInsideSandbox(dir) : root;
  const entries = await readdir(target, { withFileTypes: true });
  const files = entries.map(e => {
    const fullPath = join(target, e.name);
    const rel = relative(root, fullPath);
    return e.isDirectory() ? `${rel}/` : rel;
  });
  return { files };
}
