// Durable skill artifact revisions.
// The lifecycle table remains the release gate; this sidecar preserves the
// candidate body and host-controlled state transitions without rewriting the
// historical skills table.

import { getDb } from '../../db/sqlite.js';
import { logger } from '../../shared/logger.js';

export type SkillRevisionStatus = 'candidate' | 'verified' | 'approved' | 'published' | 'rejected' | 'deprecated' | 'rolled_back';

export interface SkillRevisionInput {
  lifecycleId: number;
  name: string;
  version: number;
  artifact: Record<string, unknown>;
  scopeKey?: string;
  sourceEpisodeIds?: string[];
}

export interface SkillRevision {
  id: number;
  lifecycleId: number;
  skillId: number | null;
  name: string;
  version: number;
  scopeKey: string;
  artifact: Record<string, unknown>;
  sourceEpisodeIds: string[];
  status: SkillRevisionStatus;
  testSummary: string | null;
  rollbackReason: string | null;
  createdAt: number;
  updatedAt: number;
}

export type SkillVerificationStatus = 'passed' | 'failed' | 'unknown';

export interface SkillRevisionVerificationSummary {
  revisionId: number;
  lifecycleId: number;
  name: string;
  version: number;
  scopeKey: string;
  status: SkillRevisionStatus;
  verifier: string | null;
  verificationStatus: SkillVerificationStatus;
  checkNames: string[];
  checkCount: number;
  failedCheckCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface SkillRevisionVerificationWindowInput {
  status?: SkillRevisionStatus;
  since?: number;
  limit?: number;
}

const VERIFICATION_CHECK_NAMES = new Set([
  'proposal_body',
  'required_fields',
  'redline_scan',
  'published_name_unique',
]);

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function hasTable(name: string): boolean {
  try {
    return Boolean(getDb().prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
  } catch {
    return false;
  }
}

function hasColumn(table: string, column: string): boolean {
  try {
    return (getDb().prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>).some((item) => item.name === column);
  } catch {
    return false;
  }
}

function boundedJson(value: unknown, maxBytes: number): string {
  try {
    const json = JSON.stringify(value);
    return json.length <= maxBytes ? json : JSON.stringify({ truncated: true });
  } catch {
    return JSON.stringify({ unserializable: true });
  }
}

function parseVerificationSummary(raw: unknown): Pick<SkillRevisionVerificationSummary, 'verifier' | 'verificationStatus' | 'checkNames' | 'checkCount' | 'failedCheckCount'> {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { verifier: null, verificationStatus: 'unknown', checkNames: [], checkCount: 0, failedCheckCount: 0 };
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid summary');
    const verifier = typeof parsed['verifier'] === 'string' ? parsed['verifier'].trim().slice(0, 64) || null : null;
    const status = parsed['status'] === 'passed' || parsed['status'] === 'failed' ? parsed['status'] : 'unknown';
    const checks = Array.isArray(parsed['checks']) ? parsed['checks'] : [];
    const names: string[] = [];
    let failedCheckCount = 0;
    for (const check of checks.slice(0, 16)) {
      if (!check || typeof check !== 'object' || Array.isArray(check)) continue;
      const name = (check as Record<string, unknown>)['name'];
      if (typeof name !== 'string' || !VERIFICATION_CHECK_NAMES.has(name) || names.includes(name)) continue;
      names.push(name);
      if ((check as Record<string, unknown>)['ok'] === false) failedCheckCount += 1;
    }
    return {
      verifier,
      verificationStatus: status,
      checkNames: names,
      checkCount: names.length,
      failedCheckCount,
    };
  } catch {
    return { verifier: null, verificationStatus: 'unknown', checkNames: [], checkCount: 0, failedCheckCount: 0 };
  }
}

function rowToRevision(row: Record<string, unknown>): SkillRevision {
  let artifact: Record<string, unknown> = {};
  let sourceEpisodeIds: string[] = [];
  try {
    const parsed = JSON.parse(String(row['artifact_json'] ?? '{}')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) artifact = parsed as Record<string, unknown>;
  } catch {
    artifact = {};
  }
  try {
    const parsed = JSON.parse(String(row['source_episode_ids'] ?? '[]')) as unknown;
    if (Array.isArray(parsed)) sourceEpisodeIds = parsed.filter((item): item is string => typeof item === 'string').slice(0, 50);
  } catch {
    sourceEpisodeIds = [];
  }
  return {
    id: Number(row['id']),
    lifecycleId: Number(row['lifecycle_id']),
    skillId: row['skill_id'] === null ? null : Number(row['skill_id']),
    name: String(row['name']),
    version: Number(row['version']),
    scopeKey: String(row['scope_key']),
    artifact,
    sourceEpisodeIds,
    status: row['status'] as SkillRevisionStatus,
    testSummary: row['test_summary'] === null ? null : String(row['test_summary']),
    rollbackReason: row['rollback_reason'] === null ? null : String(row['rollback_reason']),
    createdAt: Number(row['created_at']),
    updatedAt: Number(row['updated_at']),
  };
}

/** Record a candidate body; absence of migration keeps old callers compatible. */
export function createSkillRevision(input: SkillRevisionInput): number | null {
  if (!hasTable('skill_revisions')) return null;
  const name = input.name.trim().slice(0, 80);
  if (!name || !Number.isSafeInteger(input.lifecycleId) || !Number.isSafeInteger(input.version) || input.version < 1) return null;
  try {
    const db = getDb();
    const now = nowSec();
    const result = db.prepare(
      `INSERT INTO skill_revisions
         (lifecycle_id, name, version, scope_key, artifact_json, source_episode_ids, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'candidate', ?, ?)
       ON CONFLICT(lifecycle_id, version) DO UPDATE SET artifact_json = excluded.artifact_json,
         source_episode_ids = excluded.source_episode_ids, updated_at = excluded.updated_at`,
    ).run(
      input.lifecycleId,
      name,
      input.version,
      input.scopeKey?.trim().slice(0, 240) || 'global',
      boundedJson(input.artifact, 12_000),
      boundedJson((input.sourceEpisodeIds ?? []).filter((id) => typeof id === 'string').map((id) => id.slice(0, 120)).slice(0, 50), 4_000),
      now,
      now,
    );
    const row = db.prepare('SELECT id FROM skill_revisions WHERE lifecycle_id = ? AND version = ?').get(input.lifecycleId, input.version) as { id?: number } | undefined;
    const revisionId = row?.id ?? Number(result.lastInsertRowid);
    if (hasColumn('core_skill_lifecycle', 'revision_id')) {
      db.prepare('UPDATE core_skill_lifecycle SET revision_id = ? WHERE id = ?').run(revisionId, input.lifecycleId);
    }
    return revisionId;
  } catch (err) {
    logger.debug({ err, lifecycleId: input.lifecycleId }, 'createSkillRevision failed');
    return null;
  }
}

function mapStatus(status: string): SkillRevisionStatus | null {
  if (status === 'proposed') return 'candidate';
  if (status === 'verified' || status === 'approved' || status === 'published') return status;
  if (status === 'rejected') return 'rejected';
  return null;
}

/** Mirror a lifecycle transition; only host state-machine code should call this. */
export function updateSkillRevisionStatus(lifecycleId: number, status: string, skillId?: number): boolean {
  const mapped = mapStatus(status);
  if (!mapped || !hasTable('skill_revisions')) return false;
  try {
    const db = getDb();
    const fields = skillId === undefined ? 'status = ?, updated_at = ?' : 'status = ?, skill_id = ?, updated_at = ?';
    const params = skillId === undefined
      ? [mapped, nowSec(), lifecycleId, lifecycleId]
      : [mapped, skillId, nowSec(), lifecycleId, lifecycleId];
    const result = db.prepare(
      `UPDATE skill_revisions SET ${fields} WHERE lifecycle_id = ? AND version = (
        SELECT version FROM core_skill_lifecycle WHERE id = ?
      )`,
    ).run(...params);
    return result.changes === 1;
  } catch (err) {
    logger.debug({ err, lifecycleId, status }, 'updateSkillRevisionStatus failed');
    return false;
  }
}

/** Store bounded host verification metadata for a revision; never stores the artifact body. */
export function setSkillRevisionTestSummary(lifecycleId: number, summary: unknown): boolean {
  if (!hasTable('skill_revisions') || !Number.isSafeInteger(lifecycleId) || lifecycleId <= 0) return false;
  try {
    const db = getDb();
    const serialized = boundedJson(summary, 4_000);
    const result = db.prepare(
      `UPDATE skill_revisions SET test_summary = ?, updated_at = ?
       WHERE lifecycle_id = ? AND version = (
         SELECT version FROM core_skill_lifecycle WHERE id = ?
       )`,
    ).run(serialized, nowSec(), lifecycleId, lifecycleId);
    return result.changes === 1;
  } catch (err) {
    logger.debug({ err, lifecycleId }, 'setSkillRevisionTestSummary failed');
    return false;
  }
}

export function updateSkillRevisionVersion(lifecycleId: number, version: number): boolean {
  if (!hasTable('skill_revisions') || !Number.isSafeInteger(version) || version < 1) return false;
  try {
    const db = getDb();
    const row = db.prepare('SELECT revision_id FROM core_skill_lifecycle WHERE id = ?').get(lifecycleId) as { revision_id?: number | null } | undefined;
    if (!row?.revision_id) return false;
    const result = db.prepare('UPDATE skill_revisions SET version = ?, updated_at = ? WHERE id = ?').run(version, nowSec(), row.revision_id);
    return result.changes === 1;
  } catch (err) {
    logger.debug({ err, lifecycleId, version }, 'updateSkillRevisionVersion failed');
    return false;
  }
}

export function getSkillRevision(id: number): SkillRevision | null {
  if (!hasTable('skill_revisions')) return null;
  try {
    const row = getDb().prepare('SELECT * FROM skill_revisions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? rowToRevision(row) : null;
  } catch {
    return null;
  }
}

export function listSkillRevisions(lifecycleId: number, limit = 50): SkillRevision[] {
  if (!hasTable('skill_revisions')) return [];
  try {
    const take = Math.min(Math.max(Math.trunc(limit), 1), 200);
    return (getDb().prepare('SELECT * FROM skill_revisions WHERE lifecycle_id = ? ORDER BY version DESC LIMIT ?').all(lifecycleId, take) as Record<string, unknown>[]).map(rowToRevision);
  } catch {
    return [];
  }
}

/**
 * Return bounded, metadata-only verification rows for the monitor/evaluation
 * window. Artifact bodies, source episode ids, check reasons and rollback text
 * deliberately stay in the revision ledger and are never projected here.
 */
export function listSkillRevisionVerificationSummaries(
  input: SkillRevisionVerificationWindowInput = {},
): SkillRevisionVerificationSummary[] {
  if (!hasTable('skill_revisions')) return [];
  try {
    const clauses = ['test_summary IS NOT NULL'];
    const params: Array<string | number> = [];
    if (input.status) {
      clauses.push('status = ?');
      params.push(input.status);
    }
    if (input.since !== undefined) {
      if (!Number.isSafeInteger(input.since) || input.since <= 0) return [];
      clauses.push('updated_at >= ?');
      params.push(input.since);
    }
    const requestedLimit = input.limit === undefined ? 50 : input.limit;
    if (!Number.isSafeInteger(requestedLimit) || requestedLimit <= 0) return [];
    const limit = Math.min(200, requestedLimit);
    const rows = getDb().prepare(
      `SELECT id, lifecycle_id, name, version, scope_key, status, test_summary, created_at, updated_at
       FROM skill_revisions
       WHERE ${clauses.join(' AND ')}
       ORDER BY updated_at DESC, id DESC
       LIMIT ?`,
    ).all(...params, limit) as Record<string, unknown>[];
    return rows.map((row) => {
      const parsed = parseVerificationSummary(row['test_summary']);
      const status = row['status'];
      const safeStatus: SkillRevisionStatus =
        status === 'candidate' || status === 'verified' || status === 'approved' || status === 'published' ||
        status === 'rejected' || status === 'deprecated' || status === 'rolled_back'
          ? status
          : 'candidate';
      return {
        revisionId: Number(row['id']),
        lifecycleId: Number(row['lifecycle_id']),
        name: String(row['name'] ?? '').trim().slice(0, 80),
        version: Number(row['version']),
        scopeKey: String(row['scope_key'] ?? 'global').trim().slice(0, 240),
        status: safeStatus,
        ...parsed,
        createdAt: Number(row['created_at']),
        updatedAt: Number(row['updated_at']),
      };
    });
  } catch (err) {
    logger.debug({ err }, 'listSkillRevisionVerificationSummaries failed');
    return [];
  }
}

/**
 * Host rollback marker. Published artifacts are archived instead of deleted;
 * the nearest earlier published revision is re-enabled when available.
 */
export function rollbackSkillRevision(id: number, reason: string): boolean {
  const boundedReason = reason.trim().slice(0, 400);
  if (!boundedReason || !hasTable('skill_revisions')) return false;
  try {
    const db = getDb();
    const now = nowSec();
    return Boolean(db.transaction(() => {
      const revision = db.prepare(
        'SELECT lifecycle_id, skill_id, name, scope_key, version FROM skill_revisions WHERE id = ?',
      ).get(id) as { lifecycle_id?: number; skill_id?: number | null; name?: string; scope_key?: string; version?: number } | undefined;
      if (!revision?.lifecycle_id || !revision.name || !revision.scope_key || !revision.version) return false;
      const result = db.prepare(
        `UPDATE skill_revisions SET status = 'rolled_back', rollback_reason = ?, updated_at = ?
         WHERE id = ? AND status IN ('candidate','verified','approved','published')`,
      ).run(boundedReason, now, id);
      if (result.changes !== 1) return false;

      if (hasColumn('core_skill_lifecycle', 'rollback_reason')) {
        db.prepare('UPDATE core_skill_lifecycle SET rollback_reason = ?, updated_at = ? WHERE id = ?').run(boundedReason, now, revision.lifecycle_id);
      }

      if (revision.skill_id && hasTable('skills') && hasColumn('skills', 'archived')) {
        db.prepare('UPDATE skills SET archived = 1 WHERE id = ?').run(revision.skill_id);
        const previous = db.prepare(
          `SELECT skill_id FROM skill_revisions
           WHERE name = ? AND scope_key = ? AND version < ? AND status = 'published' AND skill_id IS NOT NULL
           ORDER BY version DESC LIMIT 1`,
        ).get(revision.name, revision.scope_key, revision.version) as { skill_id?: number | null } | undefined;
        if (previous?.skill_id) db.prepare('UPDATE skills SET archived = 0 WHERE id = ?').run(previous.skill_id);
      }
      return true;
    })());
  } catch (err) {
    logger.debug({ err, id }, 'rollbackSkillRevision failed');
    return false;
  }
}
