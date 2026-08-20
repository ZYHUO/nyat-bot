import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

let testDb: Database.Database;

// 可变的 env mock —— 每个测试可单独翻转 flag。
const mockEnv = {
  RELATIONSHIP_QUANT_ENABLED: true,
  RELATIONSHIP_PROFILE_TRIM_ENABLED: true,
};

vi.mock('../../../src/db/sqlite.js', () => ({
  getDb: () => testDb,
}));

vi.mock('../../../src/shared/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../src/env.js', () => ({
  env: () => mockEnv,
}));

const {
  percentileRank,
  linearMap,
  scoreToTier,
  mapRelationshipEventToQuality,
  computeQuantScores,
  applyDunbarCaps,
  recordRelationshipActivity,
  accumulateQualityEvent,
  computeQuantAffinity,
  trimProfileByTier,
  recomputeChatRelationships,
  TIER_LIMITS,
} = await import('../../../src/tracking/relationship-quant.js');

type MemberStat = import('../../../src/tracking/relationship-quant.js').MemberStat;

function initSchema(db: Database.Database): void {
  const migrations = [
    'migrations/0005_user_profiles.sql',
    'migrations/0018_self_history_relationship.sql',
    'migrations/0025_profile_sections.sql',
    'migrations/0069_relationship_quant.sql',
  ];
  for (const migration of migrations) {
    db.exec(readFileSync(resolve(process.cwd(), migration), 'utf-8'));
  }
}

function member(over: Partial<MemberStat>): MemberStat {
  return {
    uid: 1,
    interactionCount: 10,
    activeDays: 5,
    depth: 4,
    lastInteractionAt: null,
    existingScore: 0,
    qualityDelta: 0,
    ...over,
  };
}

const NOW_S = 1_800_000_000; // 固定"现在"(unix 秒),衰减退化测试可预测

function daysAgoS(days: number): number {
  return NOW_S - days * 86400;
}

function seedActivity(chatId: number, uid: number, count: number, days: number): void {
  // 每天 1 行, 共 days 天, 总量 count 尽量均分 (余数堆到今天)。
  const per = Math.floor(count / days);
  for (let i = 0; i < days; i++) {
    const date = new Date(Date.now() - i * 86400_000).toISOString().slice(0, 10);
    const c = i === 0 ? count - per * (days - 1) : per;
    testDb
      .prepare('INSERT INTO relationship_activity_daily (chat_id, uid, date, msg_count) VALUES (?, ?, ?, ?)')
      .run(chatId, uid, date, c);
  }
}

function seedProfile(chatId: number, uid: number): void {
  testDb
    .prepare(
      `INSERT INTO user_profiles (chat_id, uid, username, full_name, pending_messages, updated_at)
       VALUES (?, ?, 'u' || ?, 'U' || ?, '[]', unixepoch())`,
    )
    .run(chatId, uid, uid, uid);
}

function seedSection(chatId: number, uid: number, section: string, bullets: string[], updatedAtS?: number): void {
  testDb
    .prepare(
      `INSERT INTO user_profile_sections (chat_id, uid, section_name, bullets, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(chatId, uid, section, JSON.stringify(bullets), updatedAtS ?? Math.floor(Date.now() / 1000));
}

function getBullets(chatId: number, uid: number, section: string): string[] | null {
  const row = testDb
    .prepare('SELECT bullets FROM user_profile_sections WHERE chat_id = ? AND uid = ? AND section_name = ?')
    .get(chatId, uid, section) as { bullets: string } | undefined;
  return row ? (JSON.parse(row.bullets) as string[]) : null;
}

function getQuantRow(chatId: number, uid: number) {
  return testDb
    .prepare(
      `SELECT affinity, interaction_count, quant_score, quant_tier, quant_quality_pending, quant_updated_at
       FROM chat_relationships WHERE chat_id = ? AND uid = ?`,
    )
    .get(chatId, uid) as
    | {
        affinity: number;
        interaction_count: number;
        quant_score: number;
        quant_tier: number;
        quant_quality_pending: number;
        quant_updated_at: number;
      }
    | undefined;
}

beforeEach(() => {
  testDb = new Database(':memory:');
  initSchema(testDb);
  mockEnv.RELATIONSHIP_QUANT_ENABLED = true;
  mockEnv.RELATIONSHIP_PROFILE_TRIM_ENABLED = true;
});

afterEach(() => {
  testDb.close();
});

// ── 纯函数: percentileRank / linearMap / scoreToTier ─────────────

describe('percentileRank', () => {
  it('ranks values within a sorted distribution', () => {
    const sorted = [10, 20, 30, 40, 50];
    expect(percentileRank(10, sorted)).toBe(0);
    expect(percentileRank(30, sorted)).toBe(50);
    expect(percentileRank(50, sorted)).toBe(100);
  });

  it('gives tied values the same rank (count strictly below)', () => {
    const sorted = [10, 20, 20, 20, 50];
    expect(percentileRank(20, sorted)).toBe(25); // 1/4
  });

  it('returns 50 for single/empty distributions', () => {
    expect(percentileRank(42, [])).toBe(50);
    expect(percentileRank(42, [42])).toBe(50);
  });
});

describe('linearMap', () => {
  it('maps median → 50 and caps at 100', () => {
    expect(linearMap(10, 10)).toBe(50);
    expect(linearMap(20, 10)).toBe(100);
    expect(linearMap(5, 10)).toBe(25);
  });

  it('handles non-positive median (CGM semantics)', () => {
    expect(linearMap(5, 0)).toBe(50);
    expect(linearMap(0, 0)).toBe(0);
  });
});

describe('scoreToTier', () => {
  it('honors the 90/70/50 boundaries', () => {
    expect(scoreToTier(100)).toBe(1);
    expect(scoreToTier(90)).toBe(1);
    expect(scoreToTier(89.99)).toBe(2);
    expect(scoreToTier(70)).toBe(2);
    expect(scoreToTier(69.99)).toBe(3);
    expect(scoreToTier(50)).toBe(3);
    expect(scoreToTier(49.99)).toBe(4);
    expect(scoreToTier(0)).toBe(4);
  });
});

describe('mapRelationshipEventToQuality', () => {
  it('maps existing relationship event kinds onto CGM qualities', () => {
    expect(mapRelationshipEventToQuality('positive:user_replied')).toBe('friendly');
    expect(mapRelationshipEventToQuality('positive:explicit_positive')).toBe('friendly');
    expect(mapRelationshipEventToQuality('positive:user_mentioned_bot')).toBe('friendly');
    expect(mapRelationshipEventToQuality('negative:ignored')).toBe('instrumental');
    expect(mapRelationshipEventToQuality('negative:explicit_negative')).toBe('hostile');
    expect(mapRelationshipEventToQuality('negative:repair_loop')).toBe('hostile');
    expect(mapRelationshipEventToQuality('whatever')).toBe('instrumental');
    expect(mapRelationshipEventToQuality('')).toBe('instrumental');
  });
});

// ── 纯函数: computeQuantScores ──────────────────────────────────

describe('computeQuantScores', () => {
  const fresh = daysAgoS(1); // 1 天前互动过 → 无衰减

  it('percentile path (≥5 members): top member scores 100, bottom scores 0', () => {
    const members = [10, 20, 30, 40, 50, 60].map((c, i) =>
      member({ uid: i + 1, interactionCount: c, activeDays: i + 1, depth: i * 2, lastInteractionAt: fresh }),
    );
    const scores = computeQuantScores(members, { isDM: false, nowMs: NOW_S * 1000 });
    expect(scores.get(6)?.score).toBe(100); // 三个维度都是最高 → 百分位全 100
    expect(scores.get(6)?.tier).toBe(1);
    expect(scores.get(1)?.score).toBe(0); // 三个维度都是最低 → 百分位全 0
    expect(scores.get(1)?.tier).toBe(4);
    // 中间成员: 三维都排第 4/6 → 百分位 3/5 = 60
    expect(scores.get(4)?.score).toBeCloseTo(60, 5);
    expect(scores.get(4)?.tier).toBe(3);
  });

  it('applies the 50/30/20 dimension weights', () => {
    // 5 个成员: 目标成员分别只在一个维度登顶, 其余维度垫底。
    const base = { lastInteractionAt: fresh };
    const members = [
      member({ uid: 1, interactionCount: 100, activeDays: 1, depth: 0, ...base }), // 仅互动第一
      member({ uid: 2, interactionCount: 1, activeDays: 30, depth: 0, ...base }), // 仅天数第一
      member({ uid: 3, interactionCount: 1, activeDays: 1, depth: 50, ...base }), // 仅深度第一
      member({ uid: 4, interactionCount: 50, activeDays: 15, depth: 25, ...base }),
      member({ uid: 5, interactionCount: 25, activeDays: 7, depth: 12, ...base }),
    ];
    const scores = computeQuantScores(members, { isDM: false, nowMs: NOW_S * 1000 });
    expect(scores.get(1)?.score).toBeCloseTo(50, 5); // 100% × 0.5
    expect(scores.get(2)?.score).toBeCloseTo(30, 5); // 100% × 0.3
    expect(scores.get(3)?.score).toBeCloseTo(20, 5); // 100% × 0.2
  });

  it('tiny-chat fallback (<5 members): linear mapping relative to median', () => {
    const members = [5, 10, 20].map((c, i) =>
      member({ uid: i + 1, interactionCount: c, activeDays: c, depth: c, lastInteractionAt: fresh }),
    );
    const scores = computeQuantScores(members, { isDM: false, nowMs: NOW_S * 1000 });
    // 中位数 10 → 50; 20 → 100 (封顶); 5 → 25。三维同比例, base 与单维一致。
    expect(scores.get(2)?.score).toBeCloseTo(50, 5);
    expect(scores.get(2)?.tier).toBe(3);
    expect(scores.get(3)?.score).toBeCloseTo(100, 5);
    expect(scores.get(1)?.score).toBeCloseTo(25, 5);
    expect(scores.get(1)?.tier).toBe(4);
  });

  it('decays −2/day beyond 14 days of silence', () => {
    const at = (d: number) =>
      computeQuantScores(
        [member({ uid: 1, interactionCount: 10, activeDays: 10, depth: 0, lastInteractionAt: daysAgoS(d) })],
        { isDM: false, nowMs: NOW_S * 1000 },
      ).get(1)?.score;
    // 单成员线性: count 10/days 10/depth 0 → base 40
    expect(at(14)).toBeCloseTo(40, 5); // 边界: 14 天不衰减
    expect(at(1)).toBeCloseTo(40, 5);
    expect(at(20)).toBeCloseTo(40 - 12, 5); // (20−14)×2
    expect(at(30)).toBeCloseTo(40 - 32, 5);
  });

  it('DM (chatId>0 → isDM) adds +15, capped at 100', () => {
    const mk = (isDM: boolean) =>
      computeQuantScores(
        [member({ uid: 1, interactionCount: 10, activeDays: 10, depth: 0, lastInteractionAt: fresh })],
        { isDM, nowMs: NOW_S * 1000 },
      ).get(1)?.score;
    expect(mk(false)).toBeCloseTo(40, 5);
    expect(mk(true)).toBeCloseTo(55, 5);

    const capped = computeQuantScores(
      [5, 10, 20].map((c, i) => member({ uid: i + 1, interactionCount: c, activeDays: c, depth: c, lastInteractionAt: fresh })),
      { isDM: true, nowMs: NOW_S * 1000 },
    );
    expect(capped.get(3)?.score).toBe(100); // 100 + 15 → 封顶
  });

  it('applies quality deltas and clamps to [0, 100]', () => {
    const members = [5, 10, 20].map((c, i) =>
      member({ uid: i + 1, interactionCount: c, activeDays: c, depth: c, lastInteractionAt: fresh }),
    );
    members[2]!.qualityDelta = 15; // dependent +15 → 100 封顶不变
    members[0]!.qualityDelta = -20; // hostile −20 → 25−20 = 5
    const scores = computeQuantScores(members, { isDM: false, nowMs: NOW_S * 1000 });
    expect(scores.get(3)?.score).toBe(100);
    expect(scores.get(1)?.score).toBeCloseTo(5, 5);

    const floored = computeQuantScores(
      [member({ uid: 9, interactionCount: 10, activeDays: 10, depth: 0, lastInteractionAt: fresh, qualityDelta: -20 })],
      { isDM: false, nowMs: NOW_S * 1000 },
    );
    expect(floored.get(9)?.score).toBe(20); // 40 − 20, 不到 0
    const clamped = computeQuantScores(
      [member({ uid: 9, interactionCount: 10, activeDays: 10, depth: 0, lastInteractionAt: fresh, qualityDelta: -100 })],
      { isDM: false, nowMs: NOW_S * 1000 },
    );
    expect(clamped.get(9)?.score).toBe(0);
  });

  it('zero-interaction members decay from their existing score instead of re-basing', () => {
    const silent20 = computeQuantScores(
      [member({ uid: 1, interactionCount: 0, activeDays: 0, depth: 9, lastInteractionAt: daysAgoS(20), existingScore: 50 })],
      { isDM: false, nowMs: NOW_S * 1000 },
    );
    expect(silent20.get(1)?.score).toBeCloseTo(50 - 12, 5); // (20−14)×2
    expect(silent20.get(1)?.tier).toBe(4);

    // 从未互动过 → 按窗口 30 天计沉默
    const never = computeQuantScores(
      [member({ uid: 2, interactionCount: 0, lastInteractionAt: null, existingScore: 50 })],
      { isDM: false, nowMs: NOW_S * 1000 },
    );
    expect(never.get(2)?.score).toBeCloseTo(50 - 32, 5);

    // 衰减不跌破 0
    const bottomed = computeQuantScores(
      [member({ uid: 3, interactionCount: 0, lastInteractionAt: daysAgoS(60), existingScore: 10 })],
      { isDM: false, nowMs: NOW_S * 1000 },
    );
    expect(bottomed.get(3)?.score).toBe(0);
  });
});

// ── 纯函数: applyDunbarCaps ─────────────────────────────────────

describe('applyDunbarCaps', () => {
  function mkScores(entries: Array<[number, number]>) {
    const scores = new Map<number, { score: number; tier: 1 | 2 | 3 | 4 }>();
    for (const [uid, score] of entries) scores.set(uid, { score, tier: scoreToTier(score) });
    return scores;
  }

  it('demotes the lowest scores when Tier1 overflows 15', () => {
    const entries: Array<[number, number]> = [];
    for (let i = 1; i <= 16; i++) entries.push([i, 90 + i * 0.5]); // 90.5 … 98
    const scores = mkScores(entries);
    const members = entries.map(([uid]) => member({ uid, interactionCount: uid }));
    const demoted = applyDunbarCaps(scores, members);
    expect(demoted).toEqual([{ uid: 1, from: 1, to: 2 }]); // 最低分被踢到 Tier2
    expect(scores.get(1)?.tier).toBe(2);
    expect([...scores.values()].filter((s) => s.tier === 1)).toHaveLength(15);
  });

  it('does nothing when a tier is exactly at capacity', () => {
    const entries: Array<[number, number]> = [];
    for (let i = 1; i <= 15; i++) entries.push([i, 90 + i * 0.5]);
    const scores = mkScores(entries);
    const demoted = applyDunbarCaps(scores, entries.map(([uid]) => member({ uid })));
    expect(demoted).toEqual([]);
    expect([...scores.values()].every((s) => s.tier === 1)).toBe(true);
  });

  it('cascades: Tier1 overflow lands in Tier2 and re-enforces its cap', () => {
    const entries: Array<[number, number]> = [];
    for (let i = 1; i <= 16; i++) entries.push([i, 90 + i * 0.5]); // 16 个 Tier1
    for (let i = 101; i <= 150; i++) entries.push([i, 70 + (i - 100) * 0.1]); // 50 个 Tier2
    const scores = mkScores(entries);
    const members = entries.map(([uid]) => member({ uid, interactionCount: uid }));
    const demoted = applyDunbarCaps(scores, members);
    expect(demoted.filter((d) => d.from === 1)).toHaveLength(1);
    expect(demoted.filter((d) => d.from === 2)).toHaveLength(1); // 50+1 → 再挤出一个
    expect([...scores.values()].filter((s) => s.tier === 1)).toHaveLength(15);
    expect([...scores.values()].filter((s) => s.tier === 2)).toHaveLength(50);
  });
});

// ── DB: recordRelationshipActivity / accumulateQualityEvent ─────

describe('recordRelationshipActivity', () => {
  it('upserts a per-day counter', () => {
    recordRelationshipActivity(-100, 7);
    recordRelationshipActivity(-100, 7);
    recordRelationshipActivity(-100, 8);
    const rows = testDb
      .prepare('SELECT uid, msg_count FROM relationship_activity_daily WHERE chat_id = ? ORDER BY uid')
      .all(-100) as Array<{ uid: number; msg_count: number }>;
    expect(rows).toEqual([
      { uid: 7, msg_count: 2 },
      { uid: 8, msg_count: 1 },
    ]);
  });

  it('is a no-op when the flag is off or uid invalid', () => {
    mockEnv.RELATIONSHIP_QUANT_ENABLED = false;
    recordRelationshipActivity(-100, 7);
    mockEnv.RELATIONSHIP_QUANT_ENABLED = true;
    recordRelationshipActivity(-100, 0);
    const n = testDb.prepare('SELECT COUNT(*) AS c FROM relationship_activity_daily').get() as { c: number };
    expect(n.c).toBe(0);
  });
});

describe('accumulateQualityEvent', () => {
  function seedRel(chatId: number, uid: number): void {
    testDb
      .prepare(
        `INSERT INTO chat_relationships (chat_id, uid, affinity, interaction_count, last_interaction_at, updated_at)
         VALUES (?, ?, 0, 1, unixepoch(), unixepoch())`,
      )
      .run(chatId, uid);
  }
  const pending = (chatId: number, uid: number) =>
    (getQuantRow(chatId, uid)?.quant_quality_pending);

  it('accumulates mapped deltas and clamps to the single-label range', () => {
    seedRel(-100, 7);
    accumulateQualityEvent(-100, 7, 'positive:user_replied'); // friendly +10
    expect(pending(-100, 7)).toBe(10);
    accumulateQualityEvent(-100, 7, 'positive:explicit_positive'); // +10 → clamp 15
    expect(pending(-100, 7)).toBe(15);
    accumulateQualityEvent(-100, 7, 'negative:explicit_negative'); // −20 → −5
    expect(pending(-100, 7)).toBe(-5);
    accumulateQualityEvent(-100, 7, 'negative:repair_loop');
    accumulateQualityEvent(-100, 7, 'negative:explicit_negative'); // → clamp −20
    expect(pending(-100, 7)).toBe(-20);
  });

  it('ignores neutral/unknown events and respects the flag', () => {
    seedRel(-100, 7);
    accumulateQualityEvent(-100, 7, 'negative:ignored'); // instrumental 0
    accumulateQualityEvent(-100, 7, ''); // unknown
    expect(pending(-100, 7)).toBe(0);
    mockEnv.RELATIONSHIP_QUANT_ENABLED = false;
    accumulateQualityEvent(-100, 7, 'positive:user_replied');
    expect(pending(-100, 7)).toBe(0);
  });
});

// ── DB: computeQuantAffinity / recomputeChatRelationships ───────

describe('computeQuantAffinity', () => {
  it('returns null when the flag is off or the user is unknown', () => {
    mockEnv.RELATIONSHIP_QUANT_ENABLED = false;
    expect(computeQuantAffinity(-100, 7)).toBeNull();
    mockEnv.RELATIONSHIP_QUANT_ENABLED = true;
    expect(computeQuantAffinity(-100, 7)).toBeNull(); // 无任何记录
  });

  it('scores a user within the chat percentile context', () => {
    const chatId = -100;
    // 6 个成员 → 百分位路径; uid 6 全面登顶
    for (let i = 1; i <= 6; i++) {
      seedProfile(chatId, i);
      seedActivity(chatId, i, i * 10, i);
      seedSection(chatId, i, 'topics', Array.from({ length: i }, (_, j) => `t${j}`));
    }
    const top = computeQuantAffinity(chatId, 6);
    expect(top?.score).toBe(100);
    expect(top?.tier).toBe(1);
    const bottom = computeQuantAffinity(chatId, 1);
    expect(bottom?.score).toBe(0);
    expect(bottom?.tier).toBe(4);
  });

  it('gives DM chats the +15 bonus', () => {
    const uid = 777; // DM: chatId == uid > 0
    seedProfile(uid, uid);
    seedActivity(uid, uid, 10, 10);
    // 单成员线性: count/days 都是中位数 → 50/50, depth 0 → base 40, +15 = 55
    const r = computeQuantAffinity(uid, uid);
    expect(r?.score).toBeCloseTo(55, 5);
    expect(r?.tier).toBe(3);
  });
});

describe('recomputeChatRelationships', () => {
  it('persists quant sidecar without touching the LLM affinity columns', () => {
    const chatId = -100;
    // 既有关系行: affinity/count 必须原样保留
    testDb
      .prepare(
        `INSERT INTO chat_relationships (chat_id, uid, affinity, interaction_count, last_interaction_at, last_summary, updated_at, quant_quality_pending)
         VALUES (?, ?, 42, 7, unixepoch(), '旧叙事', unixepoch(), 15)`,
      )
      .run(chatId, 1);
    seedProfile(chatId, 1);
    seedActivity(chatId, 1, 10, 10);

    const r = recomputeChatRelationships(chatId);
    expect(r.members).toBe(1);

    const row = getQuantRow(chatId, 1);
    // 单成员线性 base 40 + quality 15 = 55 (无 DM, 无衰减)
    expect(row?.quant_score).toBeCloseTo(55, 5);
    expect(row?.quant_tier).toBe(3);
    expect(row?.quant_quality_pending).toBe(0); // 消费后清零
    expect(row?.quant_updated_at).toBeGreaterThan(0);
    expect(row?.affinity).toBe(42); // LLM 事件流的列不动
    expect(row?.interaction_count).toBe(7);
    const summary = testDb
      .prepare('SELECT last_summary FROM chat_relationships WHERE chat_id = ? AND uid = ?')
      .get(chatId, 1) as { last_summary: string };
    expect(summary.last_summary).toBe('旧叙事');
  });

  it('creates rows for activity-only members and applies hostile deltas', () => {
    const chatId = -100;
    seedActivity(chatId, 9, 10, 10);
    seedProfile(chatId, 9);
    testDb
      .prepare(
        `INSERT INTO chat_relationships (chat_id, uid, affinity, interaction_count, last_interaction_at, updated_at, quant_quality_pending)
         VALUES (?, ?, 0, 0, unixepoch(), unixepoch(), -20)`,
      )
      .run(chatId, 9);
    recomputeChatRelationships(chatId);
    const row = getQuantRow(chatId, 9);
    expect(row?.quant_score).toBeCloseTo(20, 5); // base 40 − 20
    expect(row?.quant_tier).toBe(4);
  });

  it('prunes activity rows outside the retention window', () => {
    const chatId = -100;
    seedActivity(chatId, 1, 5, 5);
    const oldDate = new Date(Date.now() - 40 * 86400_000).toISOString().slice(0, 10);
    testDb
      .prepare('INSERT INTO relationship_activity_daily (chat_id, uid, date, msg_count) VALUES (?, ?, ?, 3)')
      .run(chatId, 1, oldDate);
    recomputeChatRelationships(chatId);
    const old = testDb
      .prepare('SELECT COUNT(*) AS c FROM relationship_activity_daily WHERE date = ?')
      .get(oldDate) as { c: number };
    expect(old.c).toBe(0);
    const kept = testDb
      .prepare('SELECT COUNT(*) AS c FROM relationship_activity_daily WHERE chat_id = ?')
      .get(chatId) as { c: number };
    expect(kept.c).toBe(5);
  });

  it('is a no-op when the flag is off', () => {
    mockEnv.RELATIONSHIP_QUANT_ENABLED = false;
    seedActivity(-100, 1, 5, 5);
    const r = recomputeChatRelationships(-100);
    expect(r).toEqual({ members: 0, demoted: 0, trimmed: 0 });
    expect(getQuantRow(-100, 1)).toBeUndefined();
  });
});

// ── DB: trimProfileByTier ───────────────────────────────────────

describe('trimProfileByTier', () => {
  const chatId = -100;
  const uid = 7;
  const nowS = () => Math.floor(Date.now() / 1000);

  function seedAll(opts?: { facts?: number; topics?: number; recentAgeDays?: number }) {
    const facts = Array.from({ length: opts?.facts ?? 12 }, (_, i) => `fact${i}`);
    const topics = Array.from({ length: opts?.topics ?? 18 }, (_, i) => `topic${i}`);
    seedSection(chatId, uid, 'stable_facts', facts);
    seedSection(chatId, uid, 'topics', topics);
    const recentAt = nowS() - (opts?.recentAgeDays ?? 0) * 86400;
    seedSection(chatId, uid, 'recent', ['最近在聊显卡'], recentAt);
    seedSection(chatId, uid, 'maintenance', ['别提前任']); // 不受裁剪影响
  }

  it('Tier1 keeps the most (10/15, recent 14d)', () => {
    seedAll({ recentAgeDays: 10 });
    const changed = trimProfileByTier(chatId, uid, 1);
    expect(changed).toBe(true);
    expect(getBullets(chatId, uid, 'stable_facts')).toHaveLength(TIER_LIMITS[1].maxTraits);
    expect(getBullets(chatId, uid, 'topics')).toHaveLength(TIER_LIMITS[1].maxInterests);
    expect(getBullets(chatId, uid, 'recent')).toEqual(['最近在聊显卡']); // 10d < 14d 保留
    expect(getBullets(chatId, uid, 'maintenance')).toEqual(['别提前任']);
  });

  it('Tier2 crops to 6/10 and keeps recent within 7d', () => {
    seedAll({ recentAgeDays: 5 });
    trimProfileByTier(chatId, uid, 2);
    expect(getBullets(chatId, uid, 'stable_facts')).toHaveLength(6);
    expect(getBullets(chatId, uid, 'topics')).toHaveLength(10);
    expect(getBullets(chatId, uid, 'recent')).toEqual(['最近在聊显卡']);
  });

  it('Tier3 crops to 3/5 and drops recent stale beyond 3d', () => {
    seedAll({ recentAgeDays: 5 });
    trimProfileByTier(chatId, uid, 3);
    expect(getBullets(chatId, uid, 'stable_facts')).toHaveLength(3);
    expect(getBullets(chatId, uid, 'topics')).toHaveLength(5);
    expect(getBullets(chatId, uid, 'recent')).toBeNull(); // 5d > 3d → 删
  });

  it('Tier4 crops to 1/2 and drops recent stale beyond 1d', () => {
    seedAll({ recentAgeDays: 2 });
    trimProfileByTier(chatId, uid, 4);
    expect(getBullets(chatId, uid, 'stable_facts')).toEqual(['fact0']);
    expect(getBullets(chatId, uid, 'topics')).toEqual(['topic0', 'topic1']);
    expect(getBullets(chatId, uid, 'recent')).toBeNull();
  });

  it('keeps the first N bullets (not arbitrary ones)', () => {
    seedAll({ facts: 4, topics: 3 });
    trimProfileByTier(chatId, uid, 3);
    expect(getBullets(chatId, uid, 'stable_facts')).toEqual(['fact0', 'fact1', 'fact2']);
    expect(getBullets(chatId, uid, 'topics')).toEqual(['topic0', 'topic1', 'topic2']);
  });

  it('returns false and changes nothing when under the limits', () => {
    seedAll({ facts: 2, topics: 2, recentAgeDays: 0 });
    const changed = trimProfileByTier(chatId, uid, 1);
    expect(changed).toBe(false);
    expect(getBullets(chatId, uid, 'stable_facts')).toHaveLength(2);
  });

  it('is a no-op when the trim flag is off', () => {
    seedAll();
    mockEnv.RELATIONSHIP_PROFILE_TRIM_ENABLED = false;
    const changed = trimProfileByTier(chatId, uid, 4);
    expect(changed).toBe(false);
    expect(getBullets(chatId, uid, 'stable_facts')).toHaveLength(12);
  });

  it('clamps an out-of-range tier to Tier4 limits', () => {
    seedAll({ recentAgeDays: 2 });
    // 非法 tier 按 4 处理 (与 CGM 的 ?? 4 一致)
    trimProfileByTier(chatId, uid, 9 as 1 | 2 | 3 | 4);
    expect(getBullets(chatId, uid, 'stable_facts')).toEqual(['fact0']);
    expect(getBullets(chatId, uid, 'recent')).toBeNull();
  });
});

// ── DB: recompute 联动 trim (两 flag 独立门控) ──────────────────

describe('recompute + trim integration', () => {
  it('trims by the freshly computed tier when both flags are on', () => {
    const chatId = -100;
    seedProfile(chatId, 1);
    seedActivity(chatId, 1, 10, 10); // 单成员 → base 40 → Tier3
    seedSection(chatId, 1, 'stable_facts', ['a', 'b', 'c', 'd', 'e']);
    seedSection(chatId, 1, 'topics', ['x', 'y', 'z', 'w', 'v', 'u']);
    const r = recomputeChatRelationships(chatId);
    expect(r.trimmed).toBe(1);
    expect(getBullets(chatId, 1, 'stable_facts')).toHaveLength(3); // Tier3
    expect(getBullets(chatId, 1, 'topics')).toHaveLength(5);
  });

  it('skips trimming when only the trim flag is off', () => {
    const chatId = -100;
    seedProfile(chatId, 1);
    seedActivity(chatId, 1, 10, 10);
    seedSection(chatId, 1, 'stable_facts', ['a', 'b', 'c', 'd', 'e']);
    mockEnv.RELATIONSHIP_PROFILE_TRIM_ENABLED = false;
    const r = recomputeChatRelationships(chatId);
    expect(r.trimmed).toBe(0);
    expect(getBullets(chatId, 1, 'stable_facts')).toHaveLength(5);
    expect(getQuantRow(chatId, 1)?.quant_tier).toBe(3); // 评分照跑
  });
});
