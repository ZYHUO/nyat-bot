// ────────────────────────────────────────
// Self-Improvement — bot 改良自己的 prompt (AGI 自我改良)
// ────────────────────────────────────────
//
// bot 可以修改自己的 prompt 文件(prompts/ 目录下的 .md),每次修改:
//   1. 先 git 快照(或 .bak 备份)兜底回滚
//   2. 写动机说明(为什么改、动机是什么)
//   3. 改完热重载(loadCachedPrompt 30s 内自动生效,无需重启)
//
// 物理红线(不可突破):
//   - 只改 prompts/ 目录下的 .md 文件,不碰代码逻辑、不碰 .env
//   - 不重启自己(重启是外部/harness 的动作)
//   - 不删库、不 rm -rf
//
// 动机说明落 self_model_notes(复用 P4-C 的表),让 bot 能回溯
// 「我当时为什么这么改」——这是可解释的自我进化,不是无脑乱改。
// ────────────────────────────────────────

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { getDb } from '../db/sqlite.js';
import { logger } from '../shared/logger.js';

const PROMPTS_DIR = resolve(process.cwd(), 'prompts');
const BACKUP_DIR = resolve(process.cwd(), 'prompts', '.self-edit-backups');

/** 校验目标路径安全:必须在 prompts/ 下、必须是 .md 文件、不能是备份目录。 */
function safePromptPath(relativePath: string): { ok: true; full: string } | { ok: false; reason: string } {
  const clean = relativePath.replace(/\\/g, '/').replace(/^\.\.\//, '').replace(/^\/+/, '');
  if (!clean || clean.includes('..')) return { ok: false, reason: 'path traversal rejected' };
  if (!clean.endsWith('.md')) return { ok: false, reason: 'only .md prompt files allowed' };
  if (clean.startsWith('.self-edit-backups')) return { ok: false, reason: 'backup dir is read-only' };
  const full = resolve(PROMPTS_DIR, clean);
  if (!full.startsWith(PROMPTS_DIR)) return { ok: false, reason: 'path escapes prompts dir' };
  return { ok: true, full };
}

/** 备份当前内容(时间戳 .bak),返回备份路径。 */
function backup(full: string): string | null {
  try {
    if (!existsSync(full)) return null;
    mkdirSync(BACKUP_DIR, { recursive: true });
    const ts = Date.now();
    const bak = join(BACKUP_DIR, `${basename(full)}.bak-${ts}`);
    copyFileSync(full, bak);
    return bak;
  } catch (err) {
    logger.warn({ err, full }, 'self-edit: backup failed');
    return null;
  }
}

/** 记录动机说明到 self_model_notes(复用 P4-C 表)。 */
function recordMotive(relativePath: string, motive: string): void {
  try {
    const note = `[self-edit] 改了 ${relativePath}：${motive.trim().slice(0, 200)}`;
    getDb()
      .prepare(`INSERT INTO self_model_notes (note, evidence, created_at) VALUES (?, ?, ?)`)
      .run(note, null, Math.floor(Date.now() / 1000));
  } catch (err) {
    logger.warn({ err }, 'self-edit: record motive failed');
  }
}

export interface SelfEditResult {
  ok: boolean;
  reason?: string;
  backup?: string | null;
}

/**
 * 修改自己的 prompt 文件。relativePath 相对 prompts/ 目录(如 'identity/persona.md')。
 * 返回 {ok, backup}。失败返回 {ok:false, reason}。
 */
export function selfEditPrompt(relativePath: string, newContent: string, motive: string): SelfEditResult {
  const pathCheck = safePromptPath(relativePath);
  if (!pathCheck.ok) {
    logger.warn({ relativePath, reason: pathCheck.reason }, 'self-edit: rejected');
    return { ok: false, reason: pathCheck.reason };
  }
  const full = pathCheck.full;
  const content = String(newContent ?? '');
  if (!content.trim()) {
    return { ok: false, reason: 'empty content rejected' };
  }
  try {
    const bak = backup(full);
    writeFileSync(full, content, 'utf-8');
    recordMotive(relativePath, motive);
    logger.info({ relativePath, backup: bak, motive: motive.slice(0, 80) }, 'self-edit: prompt modified');
    return { ok: true, backup: bak };
  } catch (err) {
    logger.warn({ err, relativePath }, 'self-edit: write failed');
    return { ok: false, reason: 'write failed' };
  }
}

/** 读自己的 prompt 文件(供 bot 先看现状再改)。 */
export function selfReadPrompt(relativePath: string): { ok: boolean; content?: string; reason?: string } {
  const pathCheck = safePromptPath(relativePath);
  if (!pathCheck.ok) return { ok: false, reason: pathCheck.reason };
  try {
    if (!existsSync(pathCheck.full)) return { ok: false, reason: 'file not found' };
    return { ok: true, content: readFileSync(pathCheck.full, 'utf-8') };
  } catch (err) {
    logger.warn({ err, relativePath }, 'self-edit: read failed');
    return { ok: false, reason: 'read failed' };
  }
}

/** 列出 prompts/ 下可改的 .md 文件(供 bot 探索)。 */
export function selfListPrompts(): string[] {
  try {
    const out: string[] = [];
    const walk = (dir: string, prefix: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(join(dir, entry.name), rel);
        else if (entry.name.endsWith('.md')) out.push(rel);
      }
    };
    walk(PROMPTS_DIR, '');
    return out;
  } catch (err) {
    logger.warn({ err }, 'self-edit: list failed');
    return [];
  }
}
