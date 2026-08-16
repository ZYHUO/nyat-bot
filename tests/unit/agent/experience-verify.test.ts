import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: Database.Database;

vi.mock('../../../src/db/sqlite.js', () => ({
  getDb: () => db,
}));

const { computePathQuality, isPathQualityGood, summarizeToolCalls } = await import('../../../src/agent/path-quality.js');
const { recordInjectOutcome } = await import('../../../src/agent/experience-verify.js');
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

describe('computePathQuality', () => {
  it('干净路径 → 高分', () => {
    const r = computePathQuality({ totalCalls: 10, invalidCalls: 0, retryCount: 0, turns: 5 });
    expect(r.score).toBe(1);
    expect(isPathQualityGood(r.score)).toBe(true);
  });

  it('无效调用多 → 低分', () => {
    const r = computePathQuality({ totalCalls: 10, invalidCalls: 5, retryCount: 2, turns: 5 });
    expect(r.score).toBeLessThan(0.5);
    expect(isPathQualityGood(r.score)).toBe(false);
  });

  it('无调用 → 中性 0.8', () => {
    const r = computePathQuality({ totalCalls: 0, invalidCalls: 0, retryCount: 0, turns: 1 });
    expect(r.score).toBe(0.8);
    expect(isPathQualityGood(r.score)).toBe(true);
  });

  it('score clamp 到 [0,1]', () => {
    expect(computePathQuality({ totalCalls: 3, invalidCalls: 9, retryCount: 9, turns: 1 }).score).toBe(0);
  });
});

describe('summarizeToolCalls', () => {
  it('统计无效调用和连续失败重试', () => {
    const r = summarizeToolCalls([
      { name: 'sendText', ok: true },
      { name: 'search', ok: false, error: 'x' },
      { name: 'search', ok: false, error: 'x' }, // 连续失败第2次 → retry
      { name: 'sendFile', ok: true },
      { name: 'readFile', ok: false, error: 'y' },
    ]);
    expect(r.totalCalls).toBe(5);
    expect(r.invalidCalls).toBe(3);
    expect(r.retryCount).toBe(1);
  });

  it('空历史 → 0', () => {
    expect(summarizeToolCalls([])).toEqual({ totalCalls: 0, invalidCalls: 0, retryCount: 0 });
  });
});

describe('recordInjectOutcome', () => {
  it('done + 干净路径 2 次 → verified=1', () => {
    const id1 = saveOne('写代码前先跑一遍验证');
    const id2 = saveOne('写完必须 sendFile');
    for (let i = 0; i < 2; i++) {
      recordInjectOutcome({ experienceIds: [id1!, id2!], taskOutcome: 'done', pathQualityScore: 0.9 });
    }
    const rows = db.prepare('SELECT id, verified, success_count FROM experience_entries ORDER BY id').all() as {
      id: number; verified: number; success_count: number;
    }[];
    expect(rows.every((r) => r.verified === 1)).toBe(true);
    expect(rows[0]!.success_count).toBe(2);
  });

  it('failed 2 次 → verified=2(可疑)', () => {
    const id = saveOne('先发贴纸再说话');
    recordInjectOutcome({ experienceIds: [id!], taskOutcome: 'failed', pathQualityScore: 0.5 });
    recordInjectOutcome({ experienceIds: [id!], taskOutcome: 'failed', pathQualityScore: 0.5 });
    const row = db.prepare('SELECT verified FROM experience_entries WHERE id = ?').get(id) as { verified: number };
    expect(row.verified).toBe(2);
  });

  it('done 但路径脏 → 不计数(不证实)', () => {
    const id = saveOne('脏路径经验');
    recordInjectOutcome({ experienceIds: [id!], taskOutcome: 'done', pathQualityScore: 0.3 });
    const row = db.prepare('SELECT success_count, failure_count, verified FROM experience_entries WHERE id = ?').get(id) as {
      success_count: number; failure_count: number; verified: number;
    };
    expect(row.success_count).toBe(0);
    expect(row.failure_count).toBe(0);
    expect(row.verified).toBe(0);
  });

  it('success 但不足阈值 → 仍未证实', () => {
    const id = saveOne('只成功一次');
    recordInjectOutcome({ experienceIds: [id!], taskOutcome: 'done', pathQualityScore: 0.9, minSuccess: 3 });
    const row = db.prepare('SELECT verified FROM experience_entries WHERE id = ?').get(id) as { verified: number };
    expect(row.verified).toBe(0);
  });
});

describe('findRelevantExperience 降权', () => {
  it('verified=2 的经验排在 verified=1 之后', () => {
    const a = saveOne('sendFile 文件交付经验验证');
    const b = saveOne('sendFile 文件交付经验可疑');
    db.prepare('UPDATE experience_entries SET verified = 1 WHERE id = ?').run(a);
    db.prepare('UPDATE experience_entries SET verified = 2 WHERE id = ?').run(b);
    const hits = findRelevantExperience('sendFile 文件交付', 3);
    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(hits[0]!.id).toBe(a); // 已验证的排前面
  });

  it('返回 id 供注入记录', () => {
    const id = saveOne('返回 id 的经验');
    const hits = findRelevantExperience('返回 id', 1);
    expect(hits[0]!.id).toBe(id);
  });
});

function saveOne(content: string): number | null {
  const ts = Math.floor(Date.now() / 1000);
  const r = db
    .prepare('INSERT INTO experience_entries (kind, content, tags, source_episode_id, source_kind, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('trick', content, '["测试"]', null, 'episode', ts);
  return Number(r.lastInsertRowid);
}
