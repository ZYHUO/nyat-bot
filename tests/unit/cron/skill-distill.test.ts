import { describe, expect, it, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';

let db: Database.Database;
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => db }));
vi.mock('../../../src/env.js', () => ({
  env: () => ({ SKILL_DISTILL_INTERVAL_MIN: 360, SKILL_DISTILL_USAGE: 'summarize' }),
}));
vi.mock('../../../src/shared/config.js', () => ({ loadCachedPrompt: () => 'sys' }));
vi.mock('../../../src/ai/fallback.js', () => ({ callWithFallback: vi.fn(async () => ({ content: 'null' })) }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const { runSkillDistill } = await import('../../../src/cron/skill-distill.js');
const { saveSkill, getRecentSmallSkills } = await import('../../../src/agent/skills.js');

function seed(): void {
  db = new Database(':memory:');
  db.exec(readFileSync('migrations/0054_episodes_experience.sql', 'utf8'));
  db.exec(readFileSync('migrations/0071_skills.sql', 'utf8'));
  db.exec(readFileSync('migrations/0072_task_evidence.sql', 'utf8'));
  db.exec(readFileSync('migrations/0075_experience_source.sql', 'utf8'));
}

beforeEach(seed);

describe('skill-distill evidence gate', () => {
  it('ignores unverified episodes when building material', async () => {
    const now = Math.floor(Date.now() / 1000);
    db.prepare(
      `INSERT INTO episodes (task_id, chat_id, goal, outcome, summary, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('t-bad', 1, 'UNVERIFIED_SECRET_GOAL_TEXT', 'done', 'claimed without proof', now - 60);
    db.prepare(
      `INSERT INTO episodes (task_id, chat_id, goal, outcome, summary, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('t-good', 1, 'VERIFIED_REAL_GOAL_TEXT', 'done', 'checked artifact', now - 60);
    db.prepare(
      `INSERT INTO task_evidence (task_id, chat_id, lifecycle, assessment, updated_at) VALUES (?, ?, ?, ?, ?)`,
    ).run('t-bad', 1, 'done', 'unverified', now - 60);
    db.prepare(
      `INSERT INTO task_evidence (task_id, chat_id, lifecycle, assessment, updated_at) VALUES (?, ?, ?, ?, ?)`,
    ).run('t-good', 1, 'done', 'verified', now - 60);
    // Force distillable material: mock LLM to echo material back is overkill;
    // instead assert via a crafted skill run that only verified text survives.
    const { callWithFallback } = await import('../../../src/ai/fallback.js');
    let seen = '';
    (callWithFallback as ReturnType<typeof vi.fn>).mockImplementationOnce(async (args: { messages: { content: string }[] }) => {
      seen = args.messages.map((m) => m.content).join('\n');
      return { content: 'null' };
    });
    await runSkillDistill();
    expect(seen).toContain('VERIFIED_REAL_GOAL_TEXT');
    expect(seen).not.toContain('UNVERIFIED_SECRET_GOAL_TEXT');
    expect(getRecentSmallSkills(100)).toHaveLength(0);
    expect(saveSkill).toBeDefined();
  });

  it('P3-1: experience material only includes verified lineage', async () => {
    const now = Math.floor(Date.now() / 1000);
    db.prepare(`INSERT INTO experience_entries (kind, content, tags, source_episode_id, source_assessment, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run('trick', 'UNVERIFIED_EXP_SECRET_TEXT', '[]', 1, 'unverified', now - 60);
    db.prepare(`INSERT INTO experience_entries (kind, content, tags, source_episode_id, source_assessment, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run('trick', 'VERIFIED_EXP_REAL_TEXT', '[]', 2, 'verified', now - 60);
    const { callWithFallback } = await import('../../../src/ai/fallback.js');
    let seen = '';
    (callWithFallback as ReturnType<typeof vi.fn>).mockImplementationOnce(async (args: { messages: { content: string }[] }) => {
      seen = args.messages.map((m) => m.content).join('\n');
      return { content: 'null' };
    });
    await runSkillDistill();
    expect(seen).toContain('VERIFIED_EXP_REAL_TEXT');
    expect(seen).not.toContain('UNVERIFIED_EXP_SECRET_TEXT');
  });
});
