// ────────────────────────────────────────
// Core Belief View — store (Phase 0 Task 0.1)
// upsert / 读 / recordOutcome。写入只认 host 可验证 outcome。
// 无 evidence 不落库；同 (source_table, source_row_id, predicate)
// 视为同一条信念（更新 summary/confidence，不插新行）。
// ────────────────────────────────────────

import { getDb } from '../../db/sqlite.js';
import { logger } from '../../shared/logger.js';
import { laplaceConfidence, decayedConfidence } from './confidence.js';
import type { Belief, BeliefInput, BeliefStatus, BeliefView } from './types.js';

export const BELIEF_TTL_DEFAULT_SEC = 90 * 86400; // 90d

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function rowToBelief(row: Record<string, unknown>): Belief {
  return {
    id: row['id'] as number,
    sourceTable: row['source_table'] as string,
    sourceRowId: row['source_row_id'] as number,
    predicate: row['predicate'] as string,
    summary: row['summary'] as string,
    confidence: row['confidence'] as number,
    supportCount: row['support_count'] as number,
    refuteCount: row['refute_count'] as number,
    lastConfirmedAt: (row['last_confirmed_at'] as number | null) ?? null,
    ttlSec: row['ttl_sec'] as number,
    status: row['status'] as BeliefStatus,
    evidence: JSON.parse((row['evidence'] as string) ?? '[]') as string[],
    createdAt: row['created_at'] as number,
    updatedAt: row['updated_at'] as number,
  };
}

/**
 * 写入/更新一条信念。新信念 confidence=0.5（Laplace 先验）。
 * 同源同 predicate → 更新 summary/evidence（追加去重）/ttl，不重置计数。
 * 无 evidence 抛错（防 LLM 裸写）。
 */
export function upsertBelief(input: BeliefInput): number {
  if (!input.evidence || input.evidence.length === 0) {
    throw new Error('upsertBelief requires non-empty evidence');
  }
  if (!input.summary || input.summary.trim().length === 0) {
    throw new Error('upsertBelief requires non-empty summary');
  }
  const db = getDb();
  const now = nowSec();
  const ttl = input.ttlSec ?? BELIEF_TTL_DEFAULT_SEC;
  const existing = db
    .prepare(
      `SELECT id, evidence FROM core_beliefs
       WHERE source_table = ? AND source_row_id = ? AND predicate = ?`,
    )
    .get(input.sourceTable, input.sourceRowId, input.predicate) as
    | { id: number; evidence: string }
    | undefined;
  if (existing) {
    let old: string[] = [];
    try {
      old = JSON.parse(existing.evidence) as string[];
    } catch {
      old = [];
    }
    const merged = [...old];
    for (const e of input.evidence) {
      if (!merged.includes(e)) merged.push(e);
    }
    db.prepare(
      `UPDATE core_beliefs SET summary = ?, evidence = ?, ttl_sec = ?,
         status = 'active', updated_at = ? WHERE id = ?`,
    ).run(input.summary.slice(0, 200), JSON.stringify(merged), ttl, now, existing.id);
    return existing.id;
  }
  const r = db
    .prepare(
      `INSERT INTO core_beliefs
         (source_table, source_row_id, predicate, summary, confidence,
          support_count, refute_count, ttl_sec, status, evidence, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0.5, 0, 0, ?, 'active', ?, ?, ?)`,
    )
    .run(
      input.sourceTable,
      input.sourceRowId,
      input.predicate,
      input.summary.slice(0, 200),
      ttl,
      JSON.stringify(input.evidence),
      now,
      now,
    );
  return Number(r.lastInsertRowid);
}

/**
 * host 记录一次可验证 outcome：ok → support++，否则 refute++，
 * 重算 Laplace 置信度，last_confirmed_at=now，status 拉回 active。
 * 调用点只有 host（工具真实返回 / 群友实际行为），禁止在 LLM 路径上写。
 */
export function recordOutcome(beliefId: number, ok: boolean): void {
  const db = getDb();
  const row = db
    .prepare(`SELECT support_count, refute_count FROM core_beliefs WHERE id = ?`)
    .get(beliefId) as { support_count: number; refute_count: number } | undefined;
  if (!row) {
    logger.debug({ beliefId }, 'recordOutcome: belief not found');
    return;
  }
  const s = row.support_count + (ok ? 1 : 0);
  const r = row.refute_count + (ok ? 0 : 1);
  db.prepare(
    `UPDATE core_beliefs SET support_count = ?, refute_count = ?,
       confidence = ?, last_confirmed_at = ?, status = 'active', updated_at = ? WHERE id = ?`,
  ).run(s, r, laplaceConfidence(s, r), nowSec(), nowSec(), beliefId);
}

/**
 * 读某 predicate 下的活跃信念（contradicted 不返回）。
 * TTL 过期的行：effectiveStatus=stale、decayedConfidence→0.5（读侧计算，不写回）。
 */
export function getActiveBeliefs(predicate: string, opts: { now?: number } = {}): BeliefView[] {
  const now = opts.now ?? nowSec();
  const db = getDb();
  const rows = db
    .prepare(`SELECT * FROM core_beliefs WHERE predicate = ? AND status != 'contradicted'`)
    .all(predicate) as Record<string, unknown>[];
  return rows.map((row) => {
    const b = rowToBelief(row);
    const age = now - b.updatedAt;
    const stale = age >= b.ttlSec;
    return {
      ...b,
      effectiveStatus: stale ? 'stale' : b.status,
      decayedConfidence: decayedConfidence(b.confidence, age, b.ttlSec),
    };
  });
}
