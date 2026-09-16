import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies that the module imports
vi.mock('../../../src/db/redis.js', () => ({
  getRedis: () => ({}),
}));

vi.mock('../../../src/shared/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { classifyActivity } from '../../../src/tracking/activity.js';

// For unit testing the pure classifyActivity function, we don't need Redis
// The Redis-dependent functions (recordMessage, getActivitySummary) would
// need integration tests with a mock Redis

describe('classifyActivity', () => {
  it('returns "热聊" for 20+ messages in 5 min', () => {
    expect(classifyActivity(20)).toBe('热聊');
    expect(classifyActivity(50)).toBe('热聊');
  });

  it('returns "活跃" for 10-19 messages in 5 min', () => {
    expect(classifyActivity(10)).toBe('活跃');
    expect(classifyActivity(19)).toBe('活跃');
  });

  it('returns "正常" for 3-9 messages in 5 min', () => {
    expect(classifyActivity(3)).toBe('正常');
    expect(classifyActivity(9)).toBe('正常');
  });

  it('returns "冷清" for 1-2 messages in 5 min', () => {
    expect(classifyActivity(1)).toBe('冷清');
    expect(classifyActivity(2)).toBe('冷清');
  });

  it('returns "沉寂" for 0 messages in 5 min', () => {
    expect(classifyActivity(0)).toBe('沉寂');
  });

  it('handles exact boundaries', () => {
    expect(classifyActivity(0)).toBe('沉寂');
    expect(classifyActivity(1)).toBe('冷清');
    expect(classifyActivity(3)).toBe('正常');
    expect(classifyActivity(10)).toBe('活跃');
    expect(classifyActivity(20)).toBe('热聊');
  });
});
