// Open threads: what the bot said it would come back to.
//
// WHY THIS EXISTS
//
// `scratchpad` is Redis with a 30-minute TTL — right for "等下我发你文件", useless
// for "明天告诉你". Nothing carried an unfinished intention across a day, so the
// bot could never say "对了，昨天你说那个…" the way a person does.
//
// THE NARROWNESS IS THE DESIGN
//
// Only EXPLICIT commitments are recorded: the bot said it would find out, or it
// is waiting on something. A general "remember our conversations" store would
// produce exactly the uncanny recall that makes a bot feel like a bot — bringing
// up something the human had already moved past.
//
// This module only records and surfaces. It never sends, and it never decides to
// raise a thread: it tells the model the thread exists and lets it choose.

import { getDb } from '../db/sqlite.js';
import { logger } from '../shared/logger.js';
import { env } from '../env.js';

export type ThreadKind = 'promised' | 'waiting';

export interface OpenThread {
  id: number;
  chatId: number;
  uid: number;
  note: string;
  kind: ThreadKind;
  dueAt?: number;
  createdAt: number;
  surfaced: number;
  /** Days since it was opened, for rendering "昨天" / "前几天". */
  daysAgo: number;
}

const MAX_NOTE = 80;
/** After this many surfaces, stop raising it — a person does not nag. */
const MAX_SURFACES = 2;
/** Threads older than this are stale; a person has moved on. */
const MAX_AGE_SEC = 7 * 86400;

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function inline(value: string, max: number): string {
  return value.replace(/[\r\n]+/g, ' ').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, max);
}

function enabled(): boolean {
  try {
    return env().OPEN_THREADS_ENABLED === true;
  } catch {
    return false;
  }
}

/** Record something the bot owes or is waiting on. Idempotent per (chat, note). */
export function rememberThread(input: {
  chatId: number;
  uid?: number;
  note: string;
  kind: ThreadKind;
  dueAt?: number;
}): number | null {
  if (!enabled()) return null;
  if (!Number.isSafeInteger(input.chatId) || input.chatId === 0) return null;
  const note = inline(input.note, MAX_NOTE);
  if (!note) return null;
  try {
    const db = getDb();
    const existing = db.prepare(
      `SELECT id FROM open_threads WHERE chat_id = ? AND note = ? AND closed_at IS NULL LIMIT 1`,
    ).get(input.chatId, note) as { id: number } | undefined;
    if (existing) return existing.id;
    const info = db.prepare(
      `INSERT INTO open_threads (chat_id, uid, note, kind, due_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      input.chatId,
      Number.isSafeInteger(input.uid) && (input.uid ?? 0) > 0 ? input.uid : 0,
      note,
      input.kind,
      Number.isSafeInteger(input.dueAt) && (input.dueAt ?? 0) > 0 ? input.dueAt : null,
      nowSec(),
    );
    return Number(info.lastInsertRowid);
  } catch (err) {
    logger.debug({ err, chatId: input.chatId }, 'rememberThread failed (non-critical)');
    return null;
  }
}

/** Close a thread once it has been honoured or dropped. */
export function closeThread(id: number): boolean {
  if (!enabled()) return false;
  try {
    const r = getDb().prepare(
      `UPDATE open_threads SET closed_at = ? WHERE id = ? AND closed_at IS NULL`,
    ).run(nowSec(), id) as { changes?: number };
    return r.changes === 1;
  } catch (err) {
    logger.debug({ err, id }, 'closeThread failed (non-critical)');
    return false;
  }
}

/**
 * Threads worth raising now: still open, not yet due-and-passed into staleness,
 * not surfaced too often, and old enough to be worth a "对了…".
 *
 * A thread opened minutes ago is still working memory (scratchpad's job) — this
 * only surfaces ones that have had at least one quiet period, which is what makes
 * "对了，昨天…" natural rather than repetitive.
 */
export function listRaiseableThreads(chatId: number, now = nowSec()): OpenThread[] {
  if (!enabled()) return [];
  if (!Number.isSafeInteger(chatId) || chatId === 0) return [];
  try {
    const rows = getDb().prepare(
      `SELECT id, chat_id, uid, note, kind, due_at, created_at, surfaced
       FROM open_threads
       WHERE chat_id = ? AND closed_at IS NULL AND surfaced < ?
         AND created_at >= ? AND created_at <= ?
       ORDER BY COALESCE(due_at, created_at) ASC LIMIT 4`,
    ).all(chatId, MAX_SURFACES, now - MAX_AGE_SEC, now - 2 * 3600) as Array<{
      id: number; chat_id: number; uid: number; note: string; kind: string;
      due_at: number | null; created_at: number; surfaced: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      chatId: r.chat_id,
      uid: r.uid,
      note: r.note,
      kind: r.kind === 'waiting' ? 'waiting' : 'promised',
      ...(r.due_at ? { dueAt: r.due_at } : {}),
      createdAt: r.created_at,
      surfaced: r.surfaced,
      daysAgo: Math.max(0, Math.floor((now - r.created_at) / 86400)),
    }));
  } catch (err) {
    logger.debug({ err, chatId }, 'listRaiseableThreads failed (non-critical)');
    return [];
  }
}

/** Mark threads as surfaced so they do not nag. */
export function markThreadsSurfaced(ids: number[]): void {
  if (!enabled() || ids.length === 0) return;
  try {
    const db = getDb();
    const stmt = db.prepare(`UPDATE open_threads SET surfaced = surfaced + 1 WHERE id = ?`);
    db.transaction(() => { for (const id of ids) stmt.run(id); })();
  } catch (err) {
    logger.debug({ err }, 'markThreadsSurfaced failed (non-critical)');
  }
}

/**
 * Render open threads as a fact block.
 *
 * Framed as "something you were going to get back to" — an opening, not a task.
 * The model decides whether this is the moment; sometimes the answer is that the
 * conversation has moved on, and that is a legitimate choice.
 */
export function renderOpenThreads(threads: OpenThread[]): string {
  if (threads.length === 0) return '';
  const lines = ['[你还记着的事]'];
  for (const t of threads) {
    const when = t.daysAgo === 0
      ? '今天早些时候'
      : t.daysAgo === 1
        ? '昨天'
        : `${t.daysAgo} 天前`;
    const what = t.kind === 'waiting'
      ? `${when}你说在等「${t.note}」`
      : `${when}你说过要「${t.note}」`;
    lines.push(`  ${what}，还没下文。`);
  }
  lines.push('（想提就提，也可以不提——看现在合不合适。）');
  return lines.join('\n');
}
