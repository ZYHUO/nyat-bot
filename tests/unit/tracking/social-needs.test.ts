import { describe, it, expect, vi } from 'vitest';

const redisGet = vi.fn();
vi.mock('../../../src/db/redis.js', () => ({
  getRedis: () => ({ get: redisGet, set: vi.fn().mockResolvedValue('OK') }),
}));
vi.mock('../../../src/tracking/mood.js', () => ({ getChatMood: () => ({ valence: 0 }) }));
vi.mock('../../../src/tracking/relationship.js', () => ({ getRelationship: () => ({ affinity: 0 }) }));

const { composeWillingness, getSocialNeed, crowdCloseness } = await import('../../../src/tracking/social-needs.js');

describe('social-needs', () => {
  describe('composeWillingness', () => {
    it('lonelier + neutral mood + friendly crowd → high willingness', () => {
      expect(composeWillingness(1, 0, 50)).toBeCloseTo(0.5, 2); // 1 * 0.5 mood * 1
    });
    it('just spoke (need 0) → ~0 willingness', () => {
      expect(composeWillingness(0, 100, 100)).toBe(0);
    });
    it('good mood lifts the mood factor toward 1', () => {
      expect(composeWillingness(1, 100, 0)).toBeCloseTo(1, 2); // 1 * 1 * 1
    });
    it('bad mood is floored, not zeroed', () => {
      expect(composeWillingness(1, -100, 0)).toBeCloseTo(0.45, 2); // mood floor
    });
    it('chilly crowd applies a penalty', () => {
      // need 1, neutral mood (0.5), avg affinity -50 < -20 → ×0.55
      expect(composeWillingness(1, 0, -50)).toBeCloseTo(0.275, 3);
    });
  });

  describe('getSocialNeed', () => {
    it('no record → assumed lonely-ish (0.7)', async () => {
      redisGet.mockResolvedValueOnce(null);
      expect(await getSocialNeed(-100)).toBe(0.7);
    });
    it('just spoke → ~0', async () => {
      redisGet.mockResolvedValueOnce(String(Math.floor(Date.now() / 1000)));
      expect(await getSocialNeed(-100)).toBeCloseTo(0, 1);
    });
    it('silent 6h (≥ full window) → clamped to 1', async () => {
      redisGet.mockResolvedValueOnce(String(Math.floor(Date.now() / 1000) - 6 * 3600));
      expect(await getSocialNeed(-100)).toBe(1);
    });
  });

  describe('crowdCloseness', () => {
    it('averages affinity of recent non-bot speakers (mocked to 0)', () => {
      const recent = [
        { uid: 1, isBot: false, role: 'user' },
        { uid: 2, isBot: false, role: 'user' },
        { uid: 0, isBot: true, role: 'assistant' },
      ] as never[];
      expect(crowdCloseness(-100, recent)).toBe(0);
    });
    it('empty crowd → 0', () => {
      expect(crowdCloseness(-100, [])).toBe(0);
    });
  });
});
