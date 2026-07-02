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

const envValues: Record<string, unknown> = {
  PERSON_IDENTITY_ENABLED: true,
  PROFILE_MERGE_ENABLED: false,
  MEMORY_VISIBILITY_ENABLED: true,
  MEMORY_SENSITIVE_CHAT_IDS: [] as number[],
  DM_AUTO_PRIVATE: true,
};
vi.mock('../../../src/env.js', () => ({ env: () => envValues }));
vi.mock('../../../src/tracking/user-affinity.js', () => ({ getAggregatedAffinity: () => ({ affinity: 0, bucket: '', interactionTotal: 0, chatCount: 0, primaryChatId: null }) }));
vi.mock('../../../src/tracking/user-profile.js', () => ({ getUserProfilePrompt: () => 'DM 里透露的隐私画像' }));

const { getGlobalProfile, setGlobalProfile, getPersonIdentity, buildCrossGroupInjection } = await import('../../../src/tracking/person-identity.js');
const { getUserContexts } = await import('../../../src/pipeline/context/manager.js');

const GROUP_A = -1001;
const GROUP_B = -1002;
const DM = 42;

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

describe('buildCrossGroupInjection(机制3:全局画像优先 + 群内 scrub 私聊来源)', () => {
  const fresh = () => Math.floor(Date.now() / 1000);

  it('有全局画像 → 优先注入结构化全局印象(可注群,safe-by-construction)', () => {
    testDb.prepare('INSERT INTO person_identity (uid, impression, primary_chat_id, chat_count, updated_at) VALUES (42, ?, ?, 2, ?)')
      .run('原始印象', GROUP_A, fresh());
    setGlobalProfile(42, { traits: ['毒舌'], interests: ['猫'], commStyle: '短句', relationToBot: '老熟人', stablePatterns: [], sourceContextIds: [GROUP_A, DM], confidence: 0.8 });
    const out = buildCrossGroupInjection(42, GROUP_B);
    expect(out).toContain('别的地方也认识');
    expect(out).toContain('毒舌');
    expect(out).toContain('老熟人');
  });

  it('无全局画像 + impression 来自 DM(私密)+ 注入进群 → scrub 掉(返回 null)', () => {
    // primary 是 DM(正数,私密),注入目标是群 → 不能裸泄私聊画像
    testDb.prepare('INSERT INTO person_identity (uid, impression, primary_chat_id, chat_count, updated_at) VALUES (7, ?, ?, 2, ?)')
      .run('DM 里的私密印象', DM, fresh());
    expect(buildCrossGroupInjection(7, GROUP_B)).toBeNull();
  });

  it('无全局画像 + impression 来自群(shared)+ 注入进另一个群 → 放行', () => {
    testDb.prepare('INSERT INTO person_identity (uid, impression, primary_chat_id, chat_count, updated_at) VALUES (8, ?, ?, 2, ?)')
      .run('群A里的公开印象', GROUP_A, fresh());
    const out = buildCrossGroupInjection(8, GROUP_B);
    expect(out).toContain('群A里的公开印象');
  });

  it('上下文数 ≤1 → 不注入', () => {
    testDb.prepare('INSERT INTO person_identity (uid, impression, primary_chat_id, chat_count, updated_at) VALUES (9, ?, ?, 1, ?)')
      .run('只在一个地方', GROUP_A, fresh());
    expect(buildCrossGroupInjection(9, GROUP_B)).toBeNull();
  });
});
