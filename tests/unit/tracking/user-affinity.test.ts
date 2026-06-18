import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockEnv = vi.fn(() => ({ RELATIONSHIP_ENABLED: true }));
let mockRows: Array<{ chat_id: number; affinity: number; interaction_count: number; last_interaction_at: number }> = [];

vi.mock('../../../src/env.js', () => ({ env: () => mockEnv() }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { debug: vi.fn() } }));
vi.mock('../../../src/db/sqlite.js', () => ({
  getDb: () => ({ prepare: () => ({ all: () => mockRows }) }),
}));
// real decayValence/affinityBucket via partial: keep mood/relationship real
vi.mock('../../../src/tracking/mood.js', () => ({
  // identity decay (no time passed in tests via fresh timestamps) — but emulate real: value*(1-rate)^h
  decayValence: (v: number, h: number, rate: number) => v * Math.pow(1 - rate, h),
}));

import { getAggregatedAffinity } from '../../../src/tracking/user-affinity.js';

const now = () => Math.floor(Date.now() / 1000);

describe('getAggregatedAffinity', () => {
  beforeEach(() => {
    mockEnv.mockReturnValue({ RELATIONSHIP_ENABLED: true });
    mockRows = [];
  });

  it('returns zero when disabled', () => {
    mockEnv.mockReturnValue({ RELATIONSHIP_ENABLED: false });
    expect(getAggregatedAffinity(1).affinity).toBe(0);
  });

  it('returns zero when no rows', () => {
    const a = getAggregatedAffinity(1);
    expect(a.affinity).toBe(0);
    expect(a.chatCount).toBe(0);
    expect(a.primaryChatId).toBeNull();
  });

  it('single close group surfaces via the max term', () => {
    mockRows = [{ chat_id: -100, affinity: 50, interaction_count: 40, last_interaction_at: now() }];
    const a = getAggregatedAffinity(7);
    expect(a.affinity).toBeCloseTo(50, 0);
    expect(a.bucket).toBe('亲近');
    expect(a.primaryChatId).toBe(-100);
    expect(a.interactionTotal).toBe(40);
  });

  it('does NOT simply sum across groups (multi-group stays bounded)', () => {
    // three groups each 30 → simple sum would be 90; compressed stays ~30
    mockRows = [
      { chat_id: -1, affinity: 30, interaction_count: 20, last_interaction_at: now() },
      { chat_id: -2, affinity: 30, interaction_count: 20, last_interaction_at: now() },
      { chat_id: -3, affinity: 30, interaction_count: 20, last_interaction_at: now() },
    ];
    const a = getAggregatedAffinity(7);
    expect(a.affinity).toBeCloseTo(30, 0); // 0.6*30 + 0.4*30
    expect(a.affinity).toBeLessThan(45);
    expect(a.chatCount).toBe(3);
  });

  it('primaryChatId is the most-interacted group', () => {
    mockRows = [
      { chat_id: -1, affinity: 10, interaction_count: 5, last_interaction_at: now() },
      { chat_id: -2, affinity: 10, interaction_count: 99, last_interaction_at: now() },
    ];
    expect(getAggregatedAffinity(7).primaryChatId).toBe(-2);
  });

  it('clamps to [-100,100]', () => {
    mockRows = [{ chat_id: -1, affinity: 100, interaction_count: 200, last_interaction_at: now() }];
    expect(getAggregatedAffinity(7).affinity).toBeLessThanOrEqual(100);
  });
});
