import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { describe, it, expect, vi, beforeEach } from 'vitest';

let db: Database.Database;
vi.mock('../../../../src/db/sqlite.js', () => ({ getDb: () => db }));
vi.mock('../../../../src/shared/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../../src/agent/skills.js', () => ({
  saveSkill: vi.fn(() => 999),
}));

import {
  proposeSkill,
  verifySkill,
  approveSkill,
  publishSkill,
  updateSkillVersion,
  getLifecycle,
  listLifecycle,
} from '../../../../src/core/skills/lifecycle.js';

const good = {
  name: '查快递',
  triggerWhen: '用户问快递到哪了',
  steps: '1. 问单号；2. 查；3. 回',
};

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(readFileSync('migrations/0086_core_skill_lifecycle.sql', 'utf8'));
});

describe('skill lifecycle', () => {
  it('全链跑通：propose → verify → approve → publish', async () => {
    const id = proposeSkill(good);
    expect(getLifecycle(id)!.status).toBe('proposed');
    expect(verifySkill(id).ok).toBe(true);
    expect(getLifecycle(id)!.status).toBe('verified');
    expect(approveSkill(id, 1001).ok).toBe(true);
    expect(getLifecycle(id)!.status).toBe('approved');
    const pub = await publishSkill(id);
    expect(pub.ok).toBe(true);
    const row = getLifecycle(id)!;
    expect(row.status).toBe('published');
    expect(row.skillId).toBe(999);
  });

  it('字段缺失 → 直接 rejected', () => {
    const id = proposeSkill({ name: '', triggerWhen: 'x', steps: 'y' });
    expect(getLifecycle(id)!.status).toBe('rejected');
  });

  it('红线 steps → verify 拒（rm -rf /）', () => {
    const id = proposeSkill({ ...good, steps: '1. rm -rf /tmp/x 然后 rm -rf / ' });
    const r = verifySkill(id);
    expect(r.ok).toBe(false);
    expect(getLifecycle(id)!.status).toBe('rejected');
    expect(r.reason).toContain('redline');
  });

  it('.env 嗅探 → verify 拒', () => {
    const id = proposeSkill({ ...good, steps: '1. cat .env 看配置' });
    expect(verifySkill(id).ok).toBe(false);
  });

  it('跳步禁止：proposed 不能直接 approve/publish', async () => {
    const id = proposeSkill(good);
    expect(approveSkill(id, 1001).ok).toBe(false);
    expect((await publishSkill(id)).ok).toBe(false);
    expect((await publishSkill(id)).reason).toContain('human approval');
  });

  it('人审 reviewer 必填', () => {
    const id = proposeSkill(good);
    verifySkill(id);
    expect(approveSkill(id, 0).ok).toBe(false);
    expect(getLifecycle(id)!.status).toBe('verified');
  });

  it('同名 published 去重 → 走版本化', async () => {
    const a = proposeSkill(good);
    verifySkill(a);
    approveSkill(a, 1);
    await publishSkill(a);
    const b = proposeSkill(good);
    const r = verifySkill(b);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('duplicate');
    const v2 = updateSkillVersion(a, { ...good, steps: '1. 问单号；2. 查；3. 回；4. 记' });
    expect(v2).not.toBeNull();
    expect(getLifecycle(v2!)!.version).toBe(2);
  });

  it('listLifecycle 按状态过滤', () => {
    proposeSkill(good);
    proposeSkill({ ...good, name: '另一个' });
    expect(listLifecycle('proposed')).toHaveLength(2);
    expect(listLifecycle('published')).toHaveLength(0);
  });
});


describe('skill prune', () => {
  it('过期 proposed → rejected；新 proposed 不动', async () => {
    const { proposeSkill, getLifecycle } = await import('../../../../src/core/skills/lifecycle.js');
    const { pruneExpiredProposals, lifecycleStats } = await import('../../../../src/core/skills/prune.js');
    const fresh = proposeSkill({ name: '新鲜', triggerWhen: 't', steps: 's' });
    const old = proposeSkill({ name: '过期', triggerWhen: 't', steps: 's' });
    // 把 old 的 created_at 拨到 31 天前
    const { getDb } = await import('../../../../src/db/sqlite.js');
    void getDb;
    db.prepare('UPDATE core_skill_lifecycle SET created_at = ? WHERE id = ?').run(
      Math.floor(Date.now() / 1000) - 31 * 86400,
      old,
    );
    const r = pruneExpiredProposals();
    expect(r.expired).toBe(1);
    expect(getLifecycle(old)!.status).toBe('rejected');
    expect(getLifecycle(fresh)!.status).toBe('proposed');
    const st = lifecycleStats();
    expect(st.proposed).toBe(1);
    expect(st.rejected).toBe(1);
  });
});