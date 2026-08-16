import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: Database.Database;

vi.mock('../../../src/db/sqlite.js', () => ({
  getDb: () => db,
}));

const { saveExperienceEntries, findRelevantExperience } = await import('../../../src/agent/episodes.js');

function loadMigrations(): void {
  db = new Database(':memory:');
  db.exec(readFileSync(join(__dirname, '../../../migrations/0054_episodes_experience.sql'), 'utf8'));
  db.exec(readFileSync(join(__dirname, '../../../migrations/0057_experience_verify.sql'), 'utf8'));
  db.exec(readFileSync(join(__dirname, '../../../migrations/0061_experience_share.sql'), 'utf8'));
}

beforeEach(() => {
  loadMigrations();
});

function seedShared(): { selfId: number; verifiedOtherId: number; unverifiedOtherId: number } {
  saveExperienceEntries([
    { kind: 'trick', content: '本 bot 自己的经验 shared 测试', tags: ['shared'], sourceEpisodeId: 1, originBot: 'botA' },
    { kind: 'trick', content: '已验证的他人经验 shared 测试', tags: ['shared'], sourceEpisodeId: 2, originBot: 'botB' },
    { kind: 'trick', content: '未验证的他人经验 shared 测试', tags: ['shared'], sourceEpisodeId: 3, originBot: 'botB' },
  ]);
  const rows = db.prepare('SELECT id FROM experience_entries ORDER BY id').all() as { id: number }[];
  // botB 的第一条标记已验证,第二条保持未验证
  db.prepare('UPDATE experience_entries SET verified = 1 WHERE id = ?').run(rows[1]!.id);
  return { selfId: rows[0]!.id, verifiedOtherId: rows[1]!.id, unverifiedOtherId: rows[2]!.id };
}

describe('cross-bot sharing gate (AGI L5 Phase 5)', () => {
  it('allowShared: 收本 bot 的 + 已验证的他人; 未验证的他人被过滤', () => {
    const ids = seedShared();
    const hits = findRelevantExperience('shared 测试', 5, { botId: 'botA', allowShared: true });
    const hitIds = hits.map((h) => h.id);
    expect(hitIds).toContain(ids.selfId);
    expect(hitIds).toContain(ids.verifiedOtherId);
    expect(hitIds).not.toContain(ids.unverifiedOtherId); // 未验证他人经验被门控
  });

  it('allowShared=false: 只收本 bot 的', () => {
    const ids = seedShared();
    const hits = findRelevantExperience('shared 测试', 5, { botId: 'botA', allowShared: false });
    const hitIds = hits.map((h) => h.id);
    expect(hitIds).toContain(ids.selfId);
    expect(hitIds).not.toContain(ids.verifiedOtherId);
    expect(hitIds).not.toContain(ids.unverifiedOtherId);
  });

  it('botId 为 botB 时: 自己(含未验证)全收', () => {
    const ids = seedShared();
    const hits = findRelevantExperience('shared 测试', 5, { botId: 'botB', allowShared: true });
    const hitIds = hits.map((h) => h.id);
    expect(hitIds).toContain(ids.verifiedOtherId);
    expect(hitIds).toContain(ids.unverifiedOtherId); // 自己的经验不受验证门控
    expect(hitIds).not.toContain(ids.selfId); // botA 的未验证不共享给 botB
  });
});
