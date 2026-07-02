import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

let testDb: Database.Database;
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => testDb }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

// Redis 反向索引 mock:群集合 + DM 集合
const groupsByUid = new Map<number, string[]>();
const dmsByUid = new Map<number, string[]>();
vi.mock('../../../src/db/redis.js', () => ({
  getRedis: () => ({
    smembers: vi.fn(async (key: string) => {
      if (key.startsWith('xxb:user:groups:')) return groupsByUid.get(Number(key.split(':').pop())) ?? [];
      if (key.startsWith('xxb:user:dms:')) return dmsByUid.get(Number(key.split(':').pop())) ?? [];
      return [];
    }),
  }),
}));

const { getGlobalProfile, setGlobalProfile, getPersonIdentity } = await import('../../../src/tracking/person-identity.js');
const { getUserContexts } = await import('../../../src/pipeline/context/manager.js');

function initSchema(db: Database.Database): void {
  db.exec(readFileSync(resolve(process.cwd(), 'migrations/0044_person_identity.sql'), 'utf-8'));
  db.exec(readFileSync(resolve(process.cwd(), 'migrations/0047_person_profile_global.sql'), 'utf-8'));
}

beforeEach(() => {
  testDb = new Database(':memory:');
  initSchema(testDb);
  groupsByUid.clear();
  dmsByUid.clear();
});

describe('getUserContexts(机制2:群 ∪ DM)', () => {
  it('合并群集合与 DM 集合', async () => {
    groupsByUid.set(42, ['-1001', '-1002']);
    dmsByUid.set(42, ['42']);
    const ctx = await getUserContexts(42);
    expect(ctx.sort()).toEqual([-1002, -1001, 42].sort());
  });
  it('只私聊过、没进过群 → 仍算一个上下文', async () => {
    dmsByUid.set(7, ['7']);
    expect(await getUserContexts(7)).toEqual([7]);
  });
  it('无任何上下文 → 空', async () => {
    expect(await getUserContexts(99)).toEqual([]);
  });
});

describe('全局画像 setGlobalProfile / getGlobalProfile(机制2 schema)', () => {
  it('写回后可读出结构化全局画像 + last_merged_at 被设置', () => {
    setGlobalProfile(42, {
      traits: ['毒舌', '嘴硬心软'],
      interests: ['原神', '猫'],
      commStyle: '短句 + 颜文字',
      relationToBot: '老熟人,常来私聊吐槽',
      stablePatterns: ['深夜活跃'],
      sourceContextIds: [-1001, 42],
      confidence: 0.8,
    });
    const p = getGlobalProfile(42)!;
    expect(p.traits).toEqual(['毒舌', '嘴硬心软']);
    expect(p.interests).toEqual(['原神', '猫']);
    expect(p.commStyle).toBe('短句 + 颜文字');
    expect(p.sourceContextIds).toEqual([-1001, 42]);
    expect(p.confidence).toBe(0.8);
    expect(p.lastMergedAt).toBeGreaterThan(0);
  });

  it('confidence 越界被 clamp 到 [0,1]', () => {
    setGlobalProfile(1, { traits: [], interests: [], commStyle: '', relationToBot: '', stablePatterns: [], sourceContextIds: [], confidence: 5 });
    expect(getGlobalProfile(1)!.confidence).toBe(1);
  });

  it('无行时 getGlobalProfile 返回 null', () => {
    expect(getGlobalProfile(12345)).toBeNull();
  });

  it('二次合并覆盖全局列但不建重复行', () => {
    setGlobalProfile(42, { traits: ['a'], interests: [], commStyle: '', relationToBot: '', stablePatterns: [], sourceContextIds: [], confidence: 0.5 });
    setGlobalProfile(42, { traits: ['b'], interests: [], commStyle: '', relationToBot: '', stablePatterns: [], sourceContextIds: [], confidence: 0.6 });
    expect(getGlobalProfile(42)!.traits).toEqual(['b']);
    const cnt = (testDb.prepare('SELECT COUNT(*) c FROM person_identity WHERE uid = 42').get() as { c: number }).c;
    expect(cnt).toBe(1);
  });

  it('setGlobalProfile 不覆盖已有 impression(只写全局列)', () => {
    testDb.prepare('INSERT INTO person_identity (uid, impression, chat_count, updated_at) VALUES (42, ?, 2, 0)').run('老印象');
    setGlobalProfile(42, { traits: ['x'], interests: [], commStyle: '', relationToBot: '', stablePatterns: [], sourceContextIds: [], confidence: 0.3 });
    expect(getPersonIdentity(42)!.impression).toBe('老印象');
    expect(getGlobalProfile(42)!.traits).toEqual(['x']);
  });
});
