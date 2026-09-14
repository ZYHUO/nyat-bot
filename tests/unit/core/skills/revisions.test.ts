import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let db: Database.Database;
vi.mock('../../../../src/db/sqlite.js', () => ({ getDb: () => db }));
vi.mock('../../../../src/shared/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../../src/agent/skills.js', () => ({ saveSkill: vi.fn(() => 77) }));

import {
  approveSkill,
  getLifecycle,
  publishSkill,
  proposeSkill,
  updateSkillVersion,
  verifySkill,
} from '../../../../src/core/skills/lifecycle.js';
import {
  getSkillRevision,
  listSkillRevisionVerificationSummaries,
  listSkillRevisions,
  rollbackSkillRevision,
} from '../../../../src/core/skills/revisions.js';

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(readFileSync('migrations/0071_skills.sql', 'utf8'));
  db.exec(readFileSync('migrations/0086_core_skill_lifecycle.sql', 'utf8'));
  db.exec(readFileSync('migrations/0097_skill_revisions.sql', 'utf8'));
});

describe('skill revision ledger', () => {
  it('tracks candidate through publish with the exact artifact', async () => {
    const id = proposeSkill({
      name: '核验资料',
      triggerWhen: '需要核验时',
      steps: '先查来源再输出',
      tags: ['source'],
      tier: 'small',
    });
    const candidate = listSkillRevisions(id);
    expect(candidate).toHaveLength(1);
    expect(candidate[0]).toMatchObject({ version: 1, status: 'candidate', name: '核验资料' });
    expect(candidate[0]!.artifact).toMatchObject({ triggerWhen: '需要核验时', steps: '先查来源再输出', tier: 'small' });
    expect(getLifecycle(id)!.revisionId).toBe(candidate[0]!.id);
    expect(verifySkill(id).ok).toBe(true);
    expect(getSkillRevision(candidate[0]!.id)).toMatchObject({ status: 'verified' });
    const verification = JSON.parse(getSkillRevision(candidate[0]!.id)!.testSummary!);
    expect(verification).toMatchObject({ verifier: 'host_static_v1', status: 'passed' });
    expect(verification.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'required_fields', ok: true }),
      expect.objectContaining({ name: 'redline_scan', ok: true }),
      expect.objectContaining({ name: 'published_name_unique', ok: true }),
    ]));
    expect(approveSkill(id, 1001).ok).toBe(true);
    expect(getSkillRevision(candidate[0]!.id)!.status).toBe('approved');
    expect((await publishSkill(id)).ok).toBe(true);
    expect(getSkillRevision(candidate[0]!.id)).toMatchObject({ status: 'published', skillId: 77 });
  });

  it('keeps old versions and records a host rollback reason', async () => {
    const id = proposeSkill({ name: '旧版', triggerWhen: 't', steps: 's' });
    verifySkill(id);
    approveSkill(id, 1001);
    await publishSkill(id);
    const nextId = updateSkillVersion(id, { name: '新版', triggerWhen: 't2', steps: 's2' });
    expect(nextId).not.toBeNull();
    const revisions = listSkillRevisions(nextId!);
    expect(revisions).toHaveLength(1);
    expect(revisions[0]!.version).toBe(2);
    expect(rollbackSkillRevision(revisions[0]!.id, 'heldout_regression')).toBe(true);
    expect(getSkillRevision(revisions[0]!.id)).toMatchObject({ status: 'rolled_back', rollbackReason: 'heldout_regression' });
    expect(getLifecycle(nextId!)!.rollbackReason).toBe('heldout_regression');
    expect(rollbackSkillRevision(revisions[0]!.id, 'again')).toBe(false);
  });

  it('archives the rolled-back artifact and restores the previous published version', async () => {
    const first = proposeSkill({ name: '同名技能', triggerWhen: 't', steps: 'v1' });
    verifySkill(first);
    approveSkill(first, 1001);
    await publishSkill(first);
    const firstRevision = listSkillRevisions(first)[0]!;
    db.prepare('UPDATE skill_revisions SET skill_id = 11, status = \'published\' WHERE id = ?').run(firstRevision.id);
    db.prepare('INSERT INTO skills (id, name, tier, trigger_when, steps, tags, archived, created_at) VALUES (11, ?, \'small\', \'t\', \'v1\', \'[]\', 1, 1)').run('同名技能');

    const second = updateSkillVersion(first, { name: '同名技能', triggerWhen: 't', steps: 'v2' });
    expect(second).not.toBeNull();
    verifySkill(second!);
    approveSkill(second!, 1001);
    await publishSkill(second!);
    const secondRevision = listSkillRevisions(second!)[0]!;
    db.prepare('UPDATE skill_revisions SET skill_id = 12, status = \'published\' WHERE id = ?').run(secondRevision.id);
    db.prepare('INSERT INTO skills (id, name, tier, trigger_when, steps, tags, archived, created_at) VALUES (12, ?, \'small\', \'t\', \'v2\', \'[]\', 0, 2)').run('同名技能');

    expect(rollbackSkillRevision(secondRevision.id, 'heldout_regression')).toBe(true);
    expect(db.prepare('SELECT archived FROM skills WHERE id = 12').get()).toEqual({ archived: 1 });
    expect(db.prepare('SELECT archived FROM skills WHERE id = 11').get()).toEqual({ archived: 0 });
    expect(listSkillRevisions(first).map((revision) => revision.status)).toEqual(['published']);
    expect(getSkillRevision(secondRevision.id)?.status).toBe('rolled_back');
  });

  it('records a host rejection in the revision ledger', () => {
    const id = proposeSkill({ name: '危险候选', triggerWhen: 't', steps: 'rm -rf /' });
    const revision = listSkillRevisions(id)[0]!;
    expect(verifySkill(id).ok).toBe(false);
    expect(getSkillRevision(revision.id)!.status).toBe('rejected');
    const verification = JSON.parse(getSkillRevision(revision.id)!.testSummary!);
    expect(verification).toMatchObject({ verifier: 'host_static_v1', status: 'failed' });
    expect(verification.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'redline_scan', ok: false }),
    ]));
  });

  it('projects bounded verification metadata without artifact or reason text', () => {
    const passedId = proposeSkill({ name: '可观测候选', triggerWhen: 't', steps: 's' });
    expect(verifySkill(passedId).ok).toBe(true);
    const rejectedId = proposeSkill({ name: '不可用候选', triggerWhen: 't', steps: 'rm -rf /' });
    expect(verifySkill(rejectedId).ok).toBe(false);

    const rows = listSkillRevisionVerificationSummaries({ limit: 20 });
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        lifecycleId: passedId,
        status: 'verified',
        verifier: 'host_static_v1',
        verificationStatus: 'passed',
        checkCount: 4,
        failedCheckCount: 0,
      }),
      expect.objectContaining({
        lifecycleId: rejectedId,
        status: 'rejected',
        verificationStatus: 'failed',
        failedCheckCount: 1,
      }),
    ]));
    expect(rows[0]).not.toHaveProperty('artifact');
    expect(rows[0]).not.toHaveProperty('reason');
    expect(rows[0]).not.toHaveProperty('rollbackReason');
  });

  it('marks malformed verification summaries as unknown and supports status windows', () => {
    const id = proposeSkill({ name: '损坏摘要', triggerWhen: 't', steps: 's' });
    const revision = listSkillRevisions(id)[0]!;
    db.prepare('UPDATE skill_revisions SET test_summary = ?, updated_at = 10 WHERE id = ?').run('not-json', revision.id);

    expect(listSkillRevisionVerificationSummaries({ status: 'candidate', since: 10, limit: 1 })).toEqual([
      expect.objectContaining({
        lifecycleId: id,
        status: 'candidate',
        verifier: null,
        verificationStatus: 'unknown',
        checkCount: 0,
        failedCheckCount: 0,
      }),
    ]);
    expect(listSkillRevisionVerificationSummaries({ since: 11 })).toEqual([]);
  });
});
