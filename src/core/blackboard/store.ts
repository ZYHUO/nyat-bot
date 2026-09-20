// ────────────────────────────────────────
// Core 黑板 — store (Phase 0 Task 0.3)
// CRUD + 状态机。writeEntry 先过 ACL，越权直接拒绝（不抛错，
// 返回 {ok:false}，调用方按拒绝处理）。
// ────────────────────────────────────────

import { randomUUID } from 'node:crypto';
import { getDb } from '../../db/sqlite.js';
import { env } from '../../env.js';
import { logger } from '../../shared/logger.js';
import { canWrite } from './acl.js';
import type {
  Author,
  BlackboardEntry,
  BlackboardEntryInput,
  EntryKind,
  EntryStatus,
} from './types.js';

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * 黑板总闸。
 *
 * 2026-09-21：`CORE_BLACKBOARD_ENABLED` 这个旗标此前是**死的**——env.ts 里声明了、
 * .env 里开着，而全仓库没有一处读它。黑板被四个模块（agent/cognitive-workspace、
 * agency-intent-adapter、core/promote、core/loop）当存储层无条件用着，
 * 测试把它设成 false 以为关掉了黑板，其实什么都没验证。
 *
 * 现在它在 store 边界上门控全部四个入口。关掉时语义是自洽的：
 *   写不进（writeEntry → {ok:false}）、读不出（null / []）、状态不迁（false）。
 * 三个"空"都是这些函数的既有正常返回，调用方本来就要处理，不需要额外分支。
 *
 * 生产 .env 是 true，所以行为不变——这条修的是"关不掉"，不是"关一下"。
 */
function blackboardEnabled(): boolean {
  try {
    return env().CORE_BLACKBOARD_ENABLED === true;
  } catch {
    // env() 抛（配置坏）时按关处理：黑板是可选层，不该拦住启动。
    return false;
  }
}

function rowToEntry(row: Record<string, unknown>): BlackboardEntry {
  return {
    id: row['id'] as string,
    kind: row['kind'] as EntryKind,
    chatId: (row['chat_id'] as number | null) ?? null,
    author: row['author'] as Author,
    content: row['content'] as string,
    status: row['status'] as EntryStatus,
    createdAt: row['created_at'] as number,
    updatedAt: row['updated_at'] as number,
  };
}

const VALID_STATUS: EntryStatus[] = ['open', 'approved', 'rejected', 'consumed', 'superseded'];

/** 写一条。ACL 越权 → {ok:false, reason}，不写库。 */
export function writeEntry(input: BlackboardEntryInput): { ok: boolean; id?: string; reason?: string } {
  if (!blackboardEnabled()) return { ok: false, reason: 'blackboard disabled' };
  if (!canWrite(input.kind, input.author)) {
    return { ok: false, reason: `ACL denied: ${input.author} cannot write ${input.kind}` };
  }
  const id = input.id ?? randomUUID();
  const now = nowSec();
  try {
    getDb()
      .prepare(
        `INSERT OR REPLACE INTO core_blackboard
           (id, kind, chat_id, author, content, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'open', ?, ?)`,
      )
      .run(id, input.kind, input.chatId ?? null, input.author, input.content, now, now);
    return { ok: true, id };
  } catch (err) {
    logger.debug({ err, kind: input.kind }, 'blackboard write failed');
    return { ok: false, reason: 'db error' };
  }
}

export function readEntry(id: string): BlackboardEntry | null {
  if (!blackboardEnabled()) return null;
  try {
    const row = getDb().prepare(`SELECT * FROM core_blackboard WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToEntry(row) : null;
  } catch {
    return null;
  }
}

/** 按 kind+status 列条目（L2 取 authorized_intent 用）。 */
export function listEntries(kind: EntryKind, status?: EntryStatus, limit = 50): BlackboardEntry[] {
  if (!blackboardEnabled()) return [];
  try {
    const rows = (
      status
        ? getDb()
            .prepare(
              `SELECT * FROM core_blackboard WHERE kind = ? AND status = ?
               ORDER BY created_at DESC LIMIT ?`,
            )
            .all(kind, status, limit)
        : getDb()
            .prepare(`SELECT * FROM core_blackboard WHERE kind = ? ORDER BY created_at DESC LIMIT ?`)
            .all(kind, limit)
    ) as Record<string, unknown>[];
    return rows.map(rowToEntry);
  } catch {
    return [];
  }
}

/** 状态机推进（gate 审批 / L2 消费 /  supersede 旧 proposal 用）。 */
export function setEntryStatus(id: string, status: EntryStatus): boolean {
  if (!blackboardEnabled()) return false;
  if (!VALID_STATUS.includes(status)) return false;
  try {
    const r = getDb()
      .prepare(`UPDATE core_blackboard SET status = ?, updated_at = ? WHERE id = ?`)
      .run(status, nowSec(), id);
    return r.changes > 0;
  } catch {
    return false;
  }
}
