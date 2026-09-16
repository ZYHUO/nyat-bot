// ────────────────────────────────────────
// Session Digest 持久化 (CGM consciousness-memory 借鉴)
//
// Meta 的 [SESSION_DIGEST]、Subagent 的 endTask 摘要、dispatch 事件本身,
// 都作为一条 digest 落 session_digests 表(migrations/0067),构成全局叙事流:
// 重启不丢、FTS 可检索、后续 session 从这里做 delta 注入。
//
// 全部能力由 DIGEST_PERSIST_ENABLED 控制(默认关)。写入侧在 persistDigest 内部
// 检查 flag —— 调用方不需要各自判一次;读取侧不判 flag(只读、fail-soft)。
// 所有函数永不抛出:persistence/检索失败只允许 warn/debug 日志,绝不能炸 session。
//
// 时间约定:created_at / digestsSince(ts) 均为 unix **秒**(与 episodes/tasks 的
// nowSec() 一致),不是 Date.now() 的毫秒。
// ────────────────────────────────────────

import { getDb } from '../db/sqlite.js';
import { env } from '../env.js';
import { logger } from '../shared/logger.js';
import { segment } from '../memory/lexical.js';

export type DigestKind = 'meta' | 'subagent' | 'dispatch';

export interface PersistDigestInput {
  kind: DigestKind;
  sourceChatId?: number;
  taskId?: string;
  text: string;
  tags?: string[];
  importance?: number;
}

export interface SessionDigest {
  id: number;
  kind: DigestKind;
  sourceChatId: number | null;
  taskId: string | null;
  text: string;
  tags: string[];
  importance: number;
  /** unix 秒 */
  createdAt: number;
}

interface DigestDbRow {
  id: number;
  kind: string;
  source_chat_id: number | null;
  task_id: string | null;
  text: string;
  tags: string | null;
  importance: number;
  created_at: number;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function parseTags(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function toDigest(r: DigestDbRow): SessionDigest {
  return {
    id: r.id,
    kind: r.kind as DigestKind,
    sourceChatId: r.source_chat_id,
    taskId: r.task_id,
    text: r.text,
    tags: parseTags(r.tags),
    importance: r.importance,
    createdAt: r.created_at,
  };
}

/**
 * 落一条 digest(行 + FTS 同事务)。flag 关 / 空文本 → null;失败 → null(不抛)。
 * 返回 rowid 仅供测试与日志用。
 */
export function persistDigest(input: PersistDigestInput): number | null {
  try {
    if (!env().DIGEST_PERSIST_ENABLED) return null;
    const text = String(input.text ?? '').trim().slice(0, 2000);
    if (!text) return null;
    const tags = input.tags?.length
      ? JSON.stringify(input.tags.filter((t) => typeof t === 'string').slice(0, 12))
      : null;
    const importance =
      typeof input.importance === 'number' && Number.isFinite(input.importance)
        ? Math.max(0, Math.min(1, input.importance))
        : 0.5;

    const db = getDb();
    const tx = db.transaction((): number => {
      const r = db
        .prepare(
          `INSERT INTO session_digests (kind, source_chat_id, task_id, text, tags, importance, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.kind,
          input.sourceChatId ?? null,
          input.taskId ?? null,
          text,
          tags,
          importance,
          nowSec(),
        );
      const id = Number(r.lastInsertRowid);
      // FTS 与查询侧共用 segment()(0051 模式):未分词的中文整段成一个 token,双字词查不到。
      const seg = segment(text);
      if (seg) {
        db.prepare(`INSERT INTO session_digests_fts (digest_id, seg) VALUES (?, ?)`).run(id, seg);
      }
      return id;
    });
    return tx();
  } catch (err) {
    logger.warn({ err, kind: input.kind }, 'persistDigest failed (non-fatal)');
    return null;
  }
}

/** 最近 limit 条,按时间升序(最旧在前,与 global-state.recentDigests 的语义一致)。 */
export function recentDigests(limit = 8, opts?: { excludeKinds?: DigestKind[] }): SessionDigest[] {
  try {
    const n = Math.max(1, Math.min(200, limit | 0));
    const exclude = opts?.excludeKinds?.length
      ? ` AND kind NOT IN (${opts.excludeKinds.map(() => '?').join(',')})`
      : '';
    const args: Array<string | number> = [...(opts?.excludeKinds ?? []), n];
    const rows = getDb()
      .prepare(
        `SELECT * FROM (SELECT * FROM session_digests WHERE 1=1${exclude} ORDER BY created_at DESC, id DESC LIMIT ?)
         ORDER BY created_at ASC, id ASC`,
      )
      .all(...args) as DigestDbRow[];
    return rows.map(toDigest);
  } catch (err) {
    logger.debug({ err }, 'recentDigests failed (non-fatal)');
    return [];
  }
}

/** ts(unix 秒)以来的 digest,时间升序。 */
export function digestsSince(ts: number, limit = 30): SessionDigest[] {
  try {
    const n = Math.max(1, Math.min(500, limit | 0));
    const rows = getDb()
      .prepare(
        `SELECT * FROM session_digests WHERE created_at >= ? ORDER BY created_at ASC, id ASC LIMIT ?`,
      )
      .all(ts | 0, n) as DigestDbRow[];
    return rows.map(toDigest);
  } catch (err) {
    logger.debug({ err }, 'digestsSince failed (non-fatal)');
    return [];
  }
}

/**
 * FTS 检索(可作为未来 memory 工具)。查询与写入共用 segment() 分词,
 * 多 token 按 OR 匹配,FTS5 rank(BM25,越小越相关)排序。失败/空查询 → []。
 */
export function searchDigests(query: string, limit = 5): SessionDigest[] {
  try {
    const terms = segment(String(query ?? ''))
      .split(' ')
      .filter(Boolean)
      .slice(0, 8)
      // JSON.stringify 处理引号转义,避免分词结果里的字符被当 FTS5 语法解析。
      .map((t) => JSON.stringify(t));
    if (!terms.length) return [];
    const n = Math.max(1, Math.min(100, limit | 0));
    const rows = getDb()
      .prepare(
        `SELECT d.* FROM session_digests_fts f
         JOIN session_digests d ON d.id = f.digest_id
         WHERE session_digests_fts MATCH ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(`seg : (${terms.join(' OR ')})`, n) as DigestDbRow[];
    return rows.map(toDigest);
  } catch (err) {
    logger.debug({ err }, 'searchDigests failed (non-fatal)');
    return [];
  }
}
