// ────────────────────────────────────────
// Core v2 Phase 4 — skill 生命周期 store + verify
//
// propose → verify（沙箱）→ approve（人审）→ publish（写 skills 表）。
// 每一步都是 host 函数，状态机在 SQLite 里，LLM 只提供内容不推状态。
//
// verify 内容（确定性，不烧 LLM）：
//   1. 字段完整（name/trigger/steps 非空，长度上限与 saveSkill 一致）
//   2. 红线扫描（steps 里出现 rm -rf /、.env、cat 私钥路径等 → 拒）
//   3. 去重（与已 published 同名 → 拒，建议走版本化 updateSkillVersion）
// publish 内容：调旧 saveSkill 写库 + 回填 skill_id + 状态 published。
// ────────────────────────────────────────

import { getDb } from '../../db/sqlite.js';
import { logger } from '../../shared/logger.js';
import type { LifecycleRow, LifecycleStatus, ProposeInput } from './types.js';

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function rowToLifecycle(r: Record<string, unknown>): LifecycleRow {
  return {
    id: r['id'] as number,
    name: r['name'] as string,
    status: r['status'] as LifecycleStatus,
    verifyLog: (r['verify_log'] as string | null) ?? null,
    reviewer: (r['reviewer'] as number | null) ?? null,
    reviewedAt: (r['reviewed_at'] as number | null) ?? null,
    skillId: (r['skill_id'] as number | null) ?? null,
    version: (r['version'] as number) ?? 1,
    createdAt: r['created_at'] as number,
    updatedAt: r['updated_at'] as number,
  };
}

/** 提议一个候选 skill → proposed。字段缺失直接 rejected（不进门）。 */
export function proposeSkill(input: ProposeInput): number {
  const name = (input.name ?? '').trim().slice(0, 80);
  const trigger = (input.triggerWhen ?? '').trim();
  const steps = (input.steps ?? '').trim();
  const now = nowSec();
  const db = getDb();
  if (!name || !trigger || !steps) {
    const r = db
      .prepare(
        `INSERT INTO core_skill_lifecycle (name, status, verify_log, version, created_at, updated_at)
         VALUES (?, 'rejected', ?, 1, ?, ?)`,
      )
      .run(name || '(unnamed)', 'propose rejected: missing name/trigger/steps', now, now);
    return Number(r.lastInsertRowid);
  }
  const r = db
    .prepare(
      `INSERT INTO core_skill_lifecycle (name, status, version, created_at, updated_at)
       VALUES (?, 'proposed', 1, ?, ?)`,
    )
    .run(name, now, now);
  const id = Number(r.lastInsertRowid);
  // 内容暂存 verify_log（JSON），verify 时读回。proposed 行不污染 skills 表。
  db.prepare(`UPDATE core_skill_lifecycle SET verify_log = ?, updated_at = ? WHERE id = ?`).run(
    JSON.stringify({
      triggerWhen: trigger.slice(0, 500),
      steps: steps.slice(0, 2000),
      pitfalls: (input.pitfalls ?? '').slice(0, 1000),
      summary: (input.summary ?? '').slice(0, 300),
      tags: (input.tags ?? []).slice(0, 4),
      tier: input.tier ?? 'small',
      mergedFrom: (input.mergedFrom ?? []).slice(0, 20),
    }),
    now,
    id,
  );
  return id;
}

export function getLifecycle(id: number): LifecycleRow | null {
  try {
    const r = getDb().prepare(`SELECT * FROM core_skill_lifecycle WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return r ? rowToLifecycle(r) : null;
  } catch {
    return null;
  }
}

export function listLifecycle(status?: LifecycleStatus, limit = 50): LifecycleRow[] {
  try {
    const rows = status
      ? (getDb().prepare(`SELECT * FROM core_skill_lifecycle WHERE status = ? ORDER BY id DESC LIMIT ?`).all(status, limit) as Record<string, unknown>[])
      : (getDb().prepare(`SELECT * FROM core_skill_lifecycle ORDER BY id DESC LIMIT ?`).all(limit) as Record<string, unknown>[]);
    return rows.map(rowToLifecycle);
  } catch {
    return [];
  }
}

/** 红线：steps 里出现这些直接拒（与 self-edit 物理红线同源）。 */
const REDLINE_PATTERNS = [
  /rm\s+-rf\s+\/(?:\s|$)/,
  /\.env/,
  /BOT_TOKEN/,
  /id_rsa|id_ed25519|\.pem\b/,
  /DROP\s+TABLE/i,
  /DELETE\s+FROM\s+skills/i,
];

export interface VerifyResult {
  ok: boolean;
  reason?: string;
}

/**
 * 沙箱 verify（确定性）：字段完整 + 红线扫描 + 同名去重。
 * 通过 → verified；失败 → rejected（verify_log 留原因）。
 * 只能从 proposed 进（防跳步）。
 */
export function verifySkill(id: number): VerifyResult {
  const row = getLifecycle(id);
  if (!row) return { ok: false, reason: 'not found' };
  if (row.status !== 'proposed') return { ok: false, reason: `bad state: ${row.status}` };
  let body: { triggerWhen?: string; steps?: string };
  try {
    body = JSON.parse(row.verifyLog ?? '{}') as { triggerWhen?: string; steps?: string };
  } catch {
    return reject(id, 'verify failed: corrupt proposal body');
  }
  const steps = body.steps ?? '';
  for (const pat of REDLINE_PATTERNS) {
    if (pat.test(steps) || pat.test(body.triggerWhen ?? '')) {
      return reject(id, `verify failed: redline hit ${String(pat)}`);
    }
  }
  // 同名去重：已有 published 同名 skill → 拒（走版本化）
  try {
    const dup = getDb()
      .prepare(
        `SELECT l.id FROM core_skill_lifecycle l WHERE l.name = ? AND l.status = 'published' AND l.id != ? LIMIT 1`,
      )
      .get(row.name, id) as { id: number } | undefined;
    if (dup) return reject(id, `verify failed: duplicate of published #${dup.id} (use updateSkillVersion)`);
  } catch {
    /* fail-open 去重（表缺时），红线已过 */
  }
  setStatus(id, 'verified');
  return { ok: true };
}

function reject(id: number, reason: string): VerifyResult {
  try {
    getDb()
      .prepare(`UPDATE core_skill_lifecycle SET status = 'rejected', verify_log = ?, updated_at = ? WHERE id = ?`)
      .run(reason, nowSec(), id);
  } catch (err) {
    logger.debug({ err, id }, 'rejectLifecycle failed (non-critical)');
  }
  return { ok: false, reason };
}

/** 只推状态，不碰 verify_log（proposal 内容住里面，verify 通过不能覆盖）。 */
function setStatus(id: number, status: LifecycleStatus): void {
  try {
    getDb()
      .prepare(`UPDATE core_skill_lifecycle SET status = ?, updated_at = ? WHERE id = ?`)
      .run(status, nowSec(), id);
  } catch (err) {
    logger.debug({ err, id }, 'setLifecycleStatus failed (non-critical)');
  }
}

/**
 * 人审批准（唯一放行 published 的门）。
 * reviewer = 主人 uid（host 侧从 Telegram 确认回调 / 主人指令里取，
 * LLM 传不进来——这个函数只被 host 调用）。
 * 只能从 verified 进。
 */
export function approveSkill(id: number, reviewerUid: number): VerifyResult {
  const row = getLifecycle(id);
  if (!row) return { ok: false, reason: 'not found' };
  if (row.status !== 'verified') return { ok: false, reason: `bad state: ${row.status}` };
  if (!reviewerUid || reviewerUid <= 0) return { ok: false, reason: 'reviewer required' };
  try {
    getDb()
      .prepare(`UPDATE core_skill_lifecycle SET status = 'approved', reviewer = ?, reviewed_at = ?, updated_at = ? WHERE id = ?`)
      .run(reviewerUid, nowSec(), nowSec(), id);
    return { ok: true };
  } catch (err) {
    logger.debug({ err, id }, 'approveSkill failed (non-critical)');
    return { ok: false, reason: 'db error' };
  }
}

/**
 * 发布：调旧 saveSkill 写 skills 表 + 回填 skill_id → published。
 * 只能从 approved 进（人审是唯一前置）。
 * tier：默认读 proposal 的 tier（distill=small，consolidate=big）；显式传参可覆盖。
 */
export async function publishSkill(id: number, tier?: 'small' | 'big'): Promise<VerifyResult> {
  const row = getLifecycle(id);
  if (!row) return { ok: false, reason: 'not found' };
  if (row.status !== 'approved') return { ok: false, reason: `bad state: ${row.status} (needs human approval)` };
  let body: { triggerWhen: string; steps: string; pitfalls?: string; summary?: string; tags?: string[]; tier?: string };
  try {
    body = JSON.parse(row.verifyLog ?? '{}') as {
      triggerWhen: string;
      steps: string;
      pitfalls?: string;
      summary?: string;
      tags?: string[];
      tier?: string;
    };
  } catch {
    return reject(id, 'publish failed: corrupt proposal body');
  }
  const finalTier = tier ?? (body.tier === 'big' ? 'big' : 'small');
  try {
    const { saveSkill } = await import('../../agent/skills.js');
    const skillId = saveSkill({
      name: row.name,
      tier: finalTier,
      triggerWhen: body.triggerWhen,
      steps: body.steps,
      pitfalls: body.pitfalls,
      summary: body.summary,
      tags: body.tags ?? [],
    });
    if (skillId === null) return { ok: false, reason: 'saveSkill failed' };
    getDb()
      .prepare(`UPDATE core_skill_lifecycle SET status = 'published', skill_id = ?, updated_at = ? WHERE id = ?`)
      .run(skillId, nowSec(), id);
    logger.info({ lifecycleId: id, skillId, name: row.name }, 'core skill published');
    return { ok: true };
  } catch (err) {
    logger.debug({ err, id }, 'publishSkill failed (non-critical)');
    return { ok: false, reason: 'publish threw' };
  }
}

/**
 * 版本化：已 published 的 skill 出新版 → 旧 lifecycle 行保持 published，
 * 新 propose（version+1）走完整门。调用方用这个函数，version 自动递增。
 */
export function updateSkillVersion(publishedId: number, input: ProposeInput): number | null {
  const row = getLifecycle(publishedId);
  if (!row || row.status !== 'published') return null;
  const nid = proposeSkill(input);
  try {
    getDb().prepare(`UPDATE core_skill_lifecycle SET version = ? WHERE id = ?`).run(row.version + 1, nid);
  } catch {
    /* non-critical */
  }
  return nid;
}
