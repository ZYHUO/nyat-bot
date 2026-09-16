import { describe, it, expect, beforeEach, vi } from 'vitest';

interface RelRow {
  chat_id: number;
  uid: number;
  affinity: number;
  interaction_count: number;
  last_interaction_at: number;
  last_summary: string;
  updated_at: number;
}
const store = new Map<string, RelRow>();
const k = (c: number, u: number) => `${c}|${u}`;

const mockDb = {
  prepare: (sql: string) => {
    if (sql.startsWith('SELECT affinity, interaction_count, last_interaction_at, last_summary')) {
      return {
        get: (chatId: number, uid: number) => {
          const r = store.get(k(chatId, uid));
          return r
            ? { affinity: r.affinity, interaction_count: r.interaction_count, last_interaction_at: r.last_interaction_at, last_summary: r.last_summary }
            : undefined;
        },
      };
    }
    if (sql.startsWith('SELECT affinity, interaction_count FROM chat_relationships')) {
      return {
        get: (chatId: number, uid: number) => {
          const r = store.get(k(chatId, uid));
          return r ? { affinity: r.affinity, interaction_count: r.interaction_count } : undefined;
        },
      };
    }
    if (sql.startsWith('UPDATE chat_relationships')) {
      const hasSummary = sql.includes('last_summary = ?');
      return {
        run: (...args: unknown[]) => {
          let affinity: number, count: number, lastInter: number, updated: number, summary: string | undefined;
          let chatId: number, uid: number;
          if (hasSummary) {
            [affinity, count, lastInter, updated, summary, chatId, uid] = args as [number, number, number, number, string, number, number];
          } else {
            [affinity, count, lastInter, updated, chatId, uid] = args as [number, number, number, number, number, number];
          }
          const key = k(chatId, uid);
          const r = store.get(key);
          if (r) {
            r.affinity = affinity;
            r.interaction_count = count;
            r.last_interaction_at = lastInter;
            r.updated_at = updated;
            if (hasSummary) r.last_summary = summary as string;
          }
          return { changes: 1 };
        },
      };
    }
    if (sql.startsWith('INSERT INTO chat_relationships')) {
      return {
        run: (
          chatId: number,
          uid: number,
          affinity: number,
          count: number,
          lastInter: number,
          summary: string,
          updated: number,
        ) => {
          store.set(k(chatId, uid), {
            chat_id: chatId,
            uid,
            affinity,
            interaction_count: count,
            last_interaction_at: lastInter,
            last_summary: summary,
            updated_at: updated,
          });
          return { changes: 1 };
        },
      };
    }
    throw new Error('unexpected sql: ' + sql);
  },
};

vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => mockDb }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const envValues: Record<string, unknown> = {
  RELATIONSHIP_ENABLED: true,
  RELATIONSHIP_INJECT_THRESHOLD: 20,
};
vi.mock('../../../src/env.js', () => ({ env: () => envValues }));

describe('relationship', () => {
  let mod: typeof import('../../../src/tracking/relationship.js');

  beforeEach(async () => {
    store.clear();
    vi.resetModules();
    envValues['RELATIONSHIP_ENABLED'] = true;
    envValues['RELATIONSHIP_INJECT_THRESHOLD'] = 20;
    mod = await import('../../../src/tracking/relationship.js');
  });

  it('affinityBucket boundaries', () => {
    expect(mod.affinityBucket(50)).toBe('亲近');
    expect(mod.affinityBucket(30)).toBe('亲近');
    expect(mod.affinityBucket(29)).toBe('熟人');
    expect(mod.affinityBucket(10)).toBe('熟人');
    expect(mod.affinityBucket(0)).toBe('一般');
    expect(mod.affinityBucket(-10)).toBe('一般');
    expect(mod.affinityBucket(-11)).toBe('反感');
    expect(mod.affinityBucket(-100)).toBe('反感');
  });

  it('feature off: getRelationship returns default', () => {
    envValues['RELATIONSHIP_ENABLED'] = false;
    const s = mod.getRelationship(-100, 1001);
    expect(s.affinity).toBe(0);
    expect(s.bucket).toBe('一般');
    expect(s.count).toBe(0);
  });

  it('feature off: applyRelationshipEvent is no-op', () => {
    envValues['RELATIONSHIP_ENABLED'] = false;
    mod.applyRelationshipEvent(-100, 1001, 50, 'should not persist');
    expect(store.size).toBe(0);
  });

  it('default state for unknown is 0/一般', () => {
    const s = mod.getRelationship(-100, 1001);
    expect(s.affinity).toBe(0);
    expect(s.count).toBe(0);
    expect(s.bucket).toBe('一般');
  });

  it('applyRelationshipEvent persists initial event', () => {
    mod.applyRelationshipEvent(-100, 1001, 5, 'first');
    const s = mod.getRelationship(-100, 1001);
    expect(s.affinity).toBeCloseTo(5, 3); // decay-on-read: ~exact at 0 elapsed
    expect(s.count).toBe(1);
    expect(s.lastSummary).toBe('first');
  });

  it('successive events accumulate count and affinity', () => {
    mod.applyRelationshipEvent(-100, 1001, 10);
    mod.applyRelationshipEvent(-100, 1001, 5);
    mod.applyRelationshipEvent(-100, 1001, -3);
    const s = mod.getRelationship(-100, 1001);
    expect(s.affinity).toBeCloseTo(12, 3);
    expect(s.count).toBe(3);
  });

  it('clamps affinity to [-100, 100]', () => {
    mod.applyRelationshipEvent(-100, 1001, 200);
    expect(mod.getRelationship(-100, 1001).affinity).toBeCloseTo(100, 3);
    mod.applyRelationshipEvent(-100, 1001, -500);
    expect(mod.getRelationship(-100, 1001).affinity).toBeCloseTo(-100, 3);
  });

  it('updates summary only when provided', () => {
    mod.applyRelationshipEvent(-100, 1001, 5, 'first');
    mod.applyRelationshipEvent(-100, 1001, 5);  // no summary -> keep
    expect(mod.getRelationship(-100, 1001).lastSummary).toBe('first');
    mod.applyRelationshipEvent(-100, 1001, 5, 'second');
    expect(mod.getRelationship(-100, 1001).lastSummary).toBe('second');
  });

  it('non-finite delta is skipped', () => {
    mod.applyRelationshipEvent(-100, 1001, NaN);
    expect(store.size).toBe(0);
    mod.applyRelationshipEvent(-100, 1001, Infinity);
    expect(store.size).toBe(0);
  });

  it('relationshipPromptHint empty when |affinity| < threshold', () => {
    expect(mod.relationshipPromptHint({ affinity: 10, count: 5, bucket: '熟人', lastSummary: '' })).toBe('');
    expect(mod.relationshipPromptHint({ affinity: -10, count: 5, bucket: '一般', lastSummary: '' })).toBe('');
  });

  it('relationshipPromptHint non-empty above threshold', () => {
    expect(mod.relationshipPromptHint({ affinity: 50, count: 100, bucket: '亲近', lastSummary: '' }))
      .toContain('亲近');
    expect(mod.relationshipPromptHint({ affinity: -50, count: 5, bucket: '反感', lastSummary: '' }))
      .toContain('印象偏差');
  });

  it('relationshipPromptHint empty when feature off', () => {
    envValues['RELATIONSHIP_ENABLED'] = false;
    expect(mod.relationshipPromptHint({ affinity: 50, count: 100, bucket: '亲近', lastSummary: '' })).toBe('');
  });

  it('count tier reflected in hint', () => {
    const hint50 = mod.relationshipPromptHint({ affinity: 50, count: 100, bucket: '亲近', lastSummary: '' });
    const hint5 = mod.relationshipPromptHint({ affinity: 50, count: 5, bucket: '亲近', lastSummary: '' });
    expect(hint50).toContain('老朋友');
    expect(hint5).toContain('互动过几次');
  });
});
