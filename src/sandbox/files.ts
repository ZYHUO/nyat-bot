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
  // HTML charset 兜底:模型常漏 <meta charset>,Telegram 发出去用户本地打开
  // 中文乱码。这里写 HTML 时自动注入(幂等:已带的跳过;只处理 .html/.htm)。
  let finalContent = content;
  if (/\.html?$/i.test(path)) {
    finalContent = ensureHtmlCharset(content);
  }
  await writeFile(target, finalContent, 'utf8');
  return { ok: true, path: relToSandbox(target) };
}

/** 检查 HTML 是否已声明 charset;没有则在 <head> 开头注入 UTF-8。幂等,非 HTML 原样返回。 */
export function ensureHtmlCharset(content: string): string {
  if (/<meta[^>]*charset\s*=/i.test(content)) return content; // 已有 charset,不动
  // 有 <head> → 插到 <head> 后(紧贴开头);无 <head> 但像 HTML → 插到 <html> 后;都没有 → 文件头。
  const headMatch = /<head([^>]*)>/i.exec(content);
  if (headMatch) {
    const at = headMatch.index + headMatch[0].length;
    return content.slice(0, at) + '\n  <meta charset="UTF-8">' + content.slice(at);
  }
  const htmlMatch = /<html([^>]*)>/i.exec(content);
  if (htmlMatch) {
    const at = htmlMatch.index + htmlMatch[0].length;
    return content.slice(0, at) + '\n  <meta charset="UTF-8">' + content.slice(at);
  }
  // 完全不像 HTML(<head>/<html> 都没有)——可能是片段或纯文本,不注入避免破坏。
  return content;
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
