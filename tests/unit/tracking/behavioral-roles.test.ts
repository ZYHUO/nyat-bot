import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

let testDb: Database.Database;

vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => testDb }));
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => ({ zrange: vi.fn().mockResolvedValue([]) }) }));
vi.mock('../../../src/pipeline/context/manager.js', () => ({ getRecent: vi.fn().mockResolvedValue([]) }));
vi.mock('../../../src/ai/fallback.js', () => ({ callWithFallback: vi.fn() }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

const { parseRoleAssignments, buildRoleHint } = await import('../../../src/tracking/behavioral-roles.js');

function initSchema(db: Database.Database): void {
  db.exec(readFileSync(resolve(process.cwd(), 'migrations/0029_user_roles.sql'), 'utf-8'));
}

describe('behavioral-roles', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    initSchema(testDb);
  });
  afterEach(() => testDb.close());

  describe('parseRoleAssignments', () => {
    it('parses a valid role array', () => {
      const r = parseRoleAssignments('[{"uid":1,"role":"龙王","mbti":"ENFP","reason":"话痨"}]');
      expect(r).toHaveLength(1);
      expect(r[0]).toMatchObject({ uid: 1, role: '龙王', mbti: 'ENFP', reason: '话痨' });
    });
    it('tolerates fences/prose and drops invalid entries', () => {
      const r = parseRoleAssignments('好的\n```json\n[{"uid":2,"role":"技术专家"},{"role":"无uid"}]\n```');
      expect(r).toHaveLength(1);
      expect(r[0]!.uid).toBe(2);
    });
    it('returns [] on garbage', () => {
      expect(parseRoleAssignments('not json')).toEqual([]);
    });
  });

  describe('buildRoleHint', () => {
    it('returns null when no roles', () => {
      expect(buildRoleHint(-100)).toBeNull();
    });
    it('renders a compact hint', () => {
      const now = Math.floor(Date.now() / 1000);
      testDb.prepare('INSERT INTO user_roles (chat_id, uid, role_name, rationale, mbti, assigned_at, updated_at) VALUES (?,?,?,?,?,?,?)')
        .run(-100, 1, '龙王', 'r', '', now, now);
      testDb.prepare('INSERT INTO user_roles (chat_id, uid, role_name, rationale, mbti, assigned_at, updated_at) VALUES (?,?,?,?,?,?,?)')
        .run(-100, 2, '技术专家', 'r', '', now, now);
      const hint = buildRoleHint(-100);
      expect(hint).toContain('龙王(uid:1)');
      expect(hint).toContain('技术专家(uid:2)');
    });
  });
});
