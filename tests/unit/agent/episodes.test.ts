import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: Database.Database;

vi.mock('../../../src/db/sqlite.js', () => ({
  getDb: () => db,
}));

const {
  saveEpisode,
  saveExperienceEntries,
  findRelevantExperience,
  pruneExperience,
} = await import('../../../src/agent/episodes.js');

beforeEach(() => {
  db = new Database(':memory:');
  const sql = readFileSync(join(__dirname, '../../../migrations/0054_episodes_experience.sql'), 'utf8');
  db.exec(sql);
  db.exec(readFileSync(join(__dirname, '../../../migrations/0057_experience_verify.sql'), 'utf8'));
  db.exec(readFileSync(join(__dirname, '../../../migrations/0061_experience_share.sql'), 'utf8'));
});

describe('episodes store', () => {
  it('saveEpisode roundtrips and returns rowid', () => {
    const id = saveEpisode({
      taskId: 't1',
      chatId: 6251541967,
      goal: '写个贪吃蛇 HTML',
      outcome: 'done',
      summary: '写了 snake.html 并 sendFile 交付',
      lessons: ['写完文件必须 sendFile'],
      tags: ['写代码', '文件交付'],
      turns: 8,
      segments: 1,
    });
    expect(id).toBeGreaterThan(0);
    const row = db.prepare('SELECT * FROM episodes WHERE id = ?').get(id!) as Record<string, unknown>;
    expect(row['goal']).toBe('写个贪吃蛇 HTML');
    expect(row['outcome']).toBe('done');
    expect(JSON.parse(row['lessons'] as string)).toEqual(['写完文件必须 sendFile']);
    expect(row['turns']).toBe(8);
  });

  it('saveEpisode returns null instead of throwing on bad table', () => {
    db.exec('DROP TABLE episodes');
    const id = saveEpisode({
      taskId: 't2', chatId: 1, goal: 'g', outcome: 'failed',
      summary: 's', lessons: [], tags: [], turns: 0, segments: 1,
    });
    expect(id).toBeNull();
  });
});

describe('experience entries', () => {
  it('saves entries and FTS retrieval finds them by keyword', () => {
    const epId = saveEpisode({
      taskId: 't3', chatId: 1, goal: 'g', outcome: 'done',
      summary: 's', lessons: [], tags: [], turns: 0, segments: 1,
    })!;
    saveExperienceEntries([
      { kind: 'pitfall', content: '写完 HTML 文件后必须调 telegram.sendFile 交付，只说写好了用户看不到', tags: ['文件交付', 'HTML'], sourceEpisodeId: epId },
      { kind: 'trick', content: 'sandbox 里跑 Python 先用 computer.run 验证输出再交付', tags: ['验证', 'python'], sourceEpisodeId: epId },
    ]);
    const hits = findRelevantExperience('帮我写个 HTML 页面', 3);
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]!.content).toContain('sendFile');
    expect(hits[0]!.kind).toBe('pitfall');
  });

  it('FTS hit increments use_count and sets last_used_at', () => {
    saveExperienceEntries([
      { kind: 'trick', content: 'unique-xyzzy 经验内容 about 交付', tags: ['交付'], sourceEpisodeId: 1 },
    ]);
    const before = db.prepare('SELECT use_count, last_used_at FROM experience_entries').get() as { use_count: number; last_used_at: number | null };
    expect(before.use_count).toBe(0);
    expect(before.last_used_at).toBeNull();
    const hits = findRelevantExperience('交付', 3);
    expect(hits.length).toBe(1);
    const after = db.prepare('SELECT use_count, last_used_at FROM experience_entries').get() as { use_count: number; last_used_at: number };
    expect(after.use_count).toBe(1);
    expect(after.last_used_at).toBeGreaterThan(0);
  });

  it('malformed FTS query does not throw, returns empty or results', () => {
    saveExperienceEntries([
      { kind: 'trick', content: 'some experience', tags: ['tag'], sourceEpisodeId: 1 },
    ]);
    expect(() => findRelevantExperience('"unclosed quote ( ) : *', 3)).not.toThrow();
  });

  it('empty/short query returns nothing', () => {
    saveExperienceEntries([
      { kind: 'trick', content: 'some experience content', tags: ['tag'], sourceEpisodeId: 1 },
    ]);
    expect(findRelevantExperience('', 3)).toEqual([]);
    expect(findRelevantExperience('a b', 3)).toEqual([]);
  });

  it('skips blank content entries on save', () => {
    saveExperienceEntries([
      { kind: 'trick', content: '   ', tags: ['x'], sourceEpisodeId: 1 },
      { kind: 'trick', content: 'real content here', tags: ['real'], sourceEpisodeId: 1 },
    ]);
    const { c } = db.prepare('SELECT COUNT(*) AS c FROM experience_entries').get() as { c: number };
    expect(c).toBe(1);
  });
});

describe('pruneExperience', () => {
  it('evicts least-used entries when over cap', () => {
    const stmt = db.prepare(
      `INSERT INTO experience_entries (kind, content, tags, source_episode_id, use_count, created_at) VALUES (?, ?, ?, 1, ?, ?)`,
    );
    for (let i = 0; i < 10; i++) {
      stmt.run('trick', `experience number ${i}`, '["t"]', i === 9 ? 100 : 0, 1000 + i);
    }
    pruneExperience(5);
    const rows = db.prepare('SELECT content, use_count FROM experience_entries ORDER BY created_at').all() as { content: string; use_count: number }[];
    expect(rows.length).toBe(5);
    // The heavily-used newest entry must survive
    expect(rows.some((r) => r.use_count === 100)).toBe(true);
  });

  it('spares fresh entries (<36h) even when never used', () => {
    const now = Math.floor(Date.now() / 1000);
    const stmt = db.prepare(
      `INSERT INTO experience_entries (kind, content, tags, source_episode_id, use_count, created_at) VALUES (?, ?, ?, 1, ?, ?)`,
    );
    // 5 条 3 天前的老条目（有点使用）+ 2 条刚创建零使用的新条目
    for (let i = 0; i < 5; i++) stmt.run('trick', `old experience ${i}`, '["t"]', i + 1, now - 86400 * 3);
    stmt.run('trick', 'fresh unused A', '["t"]', 0, now - 3600);
    stmt.run('trick', 'fresh unused B', '["t"]', 0, now - 1800);
    pruneExperience(5);
    const rows = db.prepare('SELECT content FROM experience_entries').all() as { content: string }[];
    expect(rows.length).toBe(5);
    // 新条目豁免：没被用过也活下来；删的是老条目里最少用的两条
    expect(rows.some((r) => r.content === 'fresh unused A')).toBe(true);
    expect(rows.some((r) => r.content === 'fresh unused B')).toBe(true);
    expect(rows.some((r) => r.content === 'old experience 0')).toBe(false);
  });

  it('no-op when under cap', () => {
    saveExperienceEntries([
      { kind: 'trick', content: 'only one', tags: ['x'], sourceEpisodeId: 1 },
    ]);
    pruneExperience(5);
    const { c } = db.prepare('SELECT COUNT(*) AS c FROM experience_entries').get() as { c: number };
    expect(c).toBe(1);
  });
});
