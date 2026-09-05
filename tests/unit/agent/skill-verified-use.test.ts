import { describe, expect, it, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';

let db: Database.Database;
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => db }));

const { saveSkill, recordSkillVerifiedUse } = await import('../../../src/agent/skills.js');

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(readFileSync('migrations/0071_skills.sql', 'utf8'));
  db.exec(readFileSync('migrations/0074_skill_verified_use.sql', 'utf8'));
});

describe('skill verified use', () => {
  it('bumps verified_use only on verified tasks, never rewrites use_count', () => {
    const id = saveSkill({ name: 'probe', tier: 'small', triggerWhen: 'when x', steps: 'do x', tags: [] })!;
    recordSkillVerifiedUse([id], 'verified');
    recordSkillVerifiedUse([id], 'unverified');
    recordSkillVerifiedUse([id], 'failed');
    const row = db.prepare('SELECT use_count, verified_use_count FROM skills WHERE id = ?').get(id) as {
      use_count: number; verified_use_count: number;
    };
    expect(row).toMatchObject({ use_count: 0, verified_use_count: 1 });
  });
});
