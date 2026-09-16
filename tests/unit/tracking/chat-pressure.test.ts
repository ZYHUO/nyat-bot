import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = new Map<string, string>();
const mockRecent = vi.fn();
const mockRel = vi.fn();

vi.mock('../../../src/pipeline/context/manager.js', () => ({
  getRecent: (...a: unknown[]) => mockRecent(...a),
}));
vi.mock('../../../src/tracking/relationship.js', () => ({
  getRelationship: (...a: unknown[]) => mockRel(...a),
}));
vi.mock('../../../src/db/redis.js', () => ({
  getRedis: () => ({
    get: async (k: string) => store.get(k) ?? null,
    incr: async (k: string) => { const v = (parseInt(store.get(k) ?? '0', 10) || 0) + 1; store.set(k, String(v)); return v; },
    expire: async () => 1,
    del: async (k: string) => { store.delete(k); return 1; },
  }),
}));

import { calculatePressure, rankByPressure, markOffered, markActioned } from '../../../src/tracking/chat-pressure.js';

function msgs(n: number, uid = 1, chars = 20) {
  return Array.from({ length: n }, (_, i) => ({ uid, isBot: false, role: 'user', textContent: 'x'.repeat(chars), messageId: i }));
}

describe('chat-pressure', () => {
  beforeEach(() => {
    store.clear();
    vi.clearAllMocks();
    mockRel.mockReturnValue({ affinity: 0 });
  });

  it('an active, intimate chat outranks a quiet, stranger chat', async () => {
    mockRecent.mockImplementation(async (chatId: number) => (chatId === -1 ? msgs(20, 1) : msgs(2, 2)));
    mockRel.mockImplementation((_c: number, uid: number) => ({ affinity: uid === 1 ? 80 : 0 }));
    const ranked = await rankByPressure([-1, -2], 2);
    expect(ranked[0]!.chatId).toBe(-1);
    expect(ranked[0]!.pressure).toBeGreaterThan(ranked[1]!.pressure);
    expect(ranked[0]!.intimacy).toBeCloseTo(1.8, 1);
  });

  it('ignoredPenalty drops pressure and floors at 0.3', async () => {
    mockRecent.mockResolvedValue(msgs(10, 1));
    const base = await calculatePressure(-1);
    expect(base.ignoredPenalty).toBe(1);
    for (let i = 0; i < 5; i++) await markOffered(-1); // 5 consecutive ignores
    const penalized = await calculatePressure(-1);
    expect(penalized.ignoredPenalty).toBe(0.3); // max(0.3, 1 - 5*0.25)
    expect(penalized.pressure).toBeLessThan(base.pressure);
  });

  it('markActioned resets the ignored penalty', async () => {
    mockRecent.mockResolvedValue(msgs(10, 1));
    await markOffered(-1);
    await markOffered(-1);
    await markActioned(-1);
    const after = await calculatePressure(-1);
    expect(after.ignoredPenalty).toBe(1);
  });

  it('empty chat has near-zero volume', async () => {
    mockRecent.mockResolvedValue([]);
    const p = await calculatePressure(-9);
    expect(p.volume).toBe(0);
    expect(p.pressure).toBe(0);
  });
});
