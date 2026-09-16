import { describe, expect, it, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';

let db: Database.Database;
vi.mock('../../../../src/db/sqlite.js', () => ({ getDb: () => db }));
vi.mock('../../../../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import {
  proposeSkill,
  verifySkill,
  approveSkill,
  publishSkill,
  getLifecycle,
  listLifecycle,
} from '../../../../src/core/skills/lifecycle.js';

// skills 表 mock：publish 调 saveSkill（mock），查 skills 表验证 tier 落库
const skillsRows: { name: string; tier: string }[] = [];
vi.mock('../../../../src/agent/skills.js', () => ({
  saveSkill: vi.fn((s: { name: string; tier: string }) => {
    skillsRows.push({ name: s.name, tier: s.tier });
    return skillsRows.length;
  }),
}));

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(readFileSync('migrations/0086_core_skill_lifecycle.sql', 'utf8'));
  skillsRows.length = 0;
});

describe('phase7: distill(small) 走门 publish 落 small', () => {
  it('propose→verify→approve→publish 默认 tier=small', async () => {
    const id = proposeSkill({ name: '查快递', triggerWhen: '问快递', steps: '问单号再查' });
    expect(verifySkill(id).ok).toBe(true);
    expect(approveSkill(id, 1001).ok).toBe(true);
    expect((await publishSkill(id)).ok).toBe(true);
    expect(skillsRows).toEqual([{ name: '查快递', tier: 'small' }]);
    expect(getLifecycle(id)!.status).toBe('published');
  });
});

describe('phase7: consolidate(big) 走门 publish 落 big + mergedFrom 可追溯', () => {
  it('tier=big + mergedFrom 进 proposal，publish 按 big 落库', async () => {
    const id = proposeSkill({
      name: '群聊互动大法',
      triggerWhen: '群里冷场',
      steps: '接梗再抛话题',
      tier: 'big',
      mergedFrom: ['接梗回复', '群聊接话'],
    });
    expect(verifySkill(id).ok).toBe(true);
    expect(approveSkill(id, 1001).ok).toBe(true);
    expect((await publishSkill(id)).ok).toBe(true);
    expect(skillsRows).toEqual([{ name: '群聊互动大法', tier: 'big' }]);
    const body = JSON.parse(getLifecycle(id)!.verifyLog!) as { mergedFrom: string[] };
    expect(body.mergedFrom).toEqual(['接梗回复', '群聊接话']);
  });

  it('显式传参可覆盖 tier', async () => {
    const id = proposeSkill({ name: 'x', triggerWhen: 't', steps: 's' });
    verifySkill(id);
    approveSkill(id, 1001);
    await publishSkill(id, 'big');
    expect(skillsRows[0]!.tier).toBe('big');
  });
});

describe('phase7: 旧直写口子已封（编译期）', () => {
  it('distill/consolidate 不再 import saveSkill', async () => {
    const distill = readFileSync('src/cron/skill-distill.ts', 'utf8');
    const consolidate = readFileSync('src/cron/skill-consolidate.ts', 'utf8');
    expect(distill).not.toMatch(/from '.*agent\/skills\.js'/);
    expect(consolidate).not.toMatch(/saveSkill/);
    expect(distill).toContain('proposeSkill');
    expect(consolidate).toContain('proposeSkill');
    expect(listLifecycle()).toHaveLength(0);
  });
});
