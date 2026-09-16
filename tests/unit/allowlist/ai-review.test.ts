import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Redis } from 'ioredis';
import type { AllowlistConfig, PendingRequest } from '../../../src/allowlist/types.js';

// Mock logger
vi.mock('../../../src/shared/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

function createRedisMock() {
  const store = new Map<string, Map<string, string>>();

  function getHash(key: string): Map<string, string> {
    if (!store.has(key)) store.set(key, new Map());
    return store.get(key)!;
  }

  const mock = {
    hget: vi.fn(async (key: string, field: string) => {
      return getHash(key).get(field) ?? null;
    }),
    hset: vi.fn(async (key: string, field: string, value: string) => {
      getHash(key).set(field, value);
      return 1;
    }),
    hgetall: vi.fn(async (key: string) => {
      const hash = getHash(key);
      const result: Record<string, string> = {};
      for (const [k, v] of hash) result[k] = v;
      return result;
    }),
    hdel: vi.fn(async (key: string, field: string) => {
      const hash = getHash(key);
      if (hash.has(field)) {
        hash.delete(field);
        return 1;
      }
      return 0;
    }),
    incr: vi.fn(async () => 1),
    expire: vi.fn(async () => 1),
  };

  return mock as unknown as Redis & typeof mock;
}

function defaultConfig(overrides: Partial<AllowlistConfig> = {}): AllowlistConfig {
  return {
    enabled: true,
    redisPrefix: 'xxb:mal:',
    defaultEnabledAfterApproval: true,
    maxSubmissionsPerUserPerDay: 3,
    autoAiReviewOnSubmit: true,
    autoAiReviewMessageLimit: 50,
    aiReviewContextMaxChars: 5000,
    aiApproveAutoEnable: true,
    aiApproveConfidenceThreshold: 0.85,
    ...overrides,
  };
}

async function importModules() {
  const aiReview = await import('../../../src/allowlist/ai-review.js');
  return aiReview;
}

describe('ai-review', () => {
  let mod: Awaited<ReturnType<typeof importModules>>;

  beforeEach(async () => {
    mod = await importModules();
  });

  describe('parseAiReviewResult', () => {
    it('parses valid APPROVE response', () => {
      const raw = '{"decision":"APPROVE","confidence":0.92,"reason":"Looks good"}';
      const result = mod.parseAiReviewResult(raw);
      expect(result).toEqual({
        decision: 'APPROVE',
        confidence: 0.92,
        reason: 'Looks good',
      });
    });

    it('parses valid REJECT response', () => {
      const raw = '{"decision":"REJECT","confidence":0.88,"reason":"Spam group"}';
      const result = mod.parseAiReviewResult(raw);
      expect(result).toEqual({
        decision: 'REJECT',
        confidence: 0.88,
        reason: 'Spam group',
      });
    });

    it('extracts JSON from markdown-wrapped response', () => {
      const raw = '```json\n{"decision":"APPROVE","confidence":0.95,"reason":"ok"}\n```';
      const result = mod.parseAiReviewResult(raw);
      expect(result).not.toBeNull();
      expect(result!.decision).toBe('APPROVE');
      expect(result!.confidence).toBe(0.95);
    });

    it('returns null for invalid decision', () => {
      const raw = '{"decision":"MAYBE","confidence":0.5,"reason":"unsure"}';
      expect(mod.parseAiReviewResult(raw)).toBeNull();
    });

    it('returns null for out-of-range confidence', () => {
      const raw = '{"decision":"APPROVE","confidence":1.5,"reason":"too high"}';
      expect(mod.parseAiReviewResult(raw)).toBeNull();

      const raw2 = '{"decision":"APPROVE","confidence":-0.1,"reason":"negative"}';
      expect(mod.parseAiReviewResult(raw2)).toBeNull();
    });

    it('returns null for non-JSON', () => {
      expect(mod.parseAiReviewResult('This is not JSON at all')).toBeNull();
      expect(mod.parseAiReviewResult('')).toBeNull();
    });
  });

  describe('shouldAutoApprove', () => {
    it('returns true for APPROVE with confidence >= threshold', () => {
      expect(
        mod.shouldAutoApprove(
          { decision: 'APPROVE', confidence: 0.90, reason: 'ok' },
          0.85,
        ),
      ).toBe(true);

      // Exactly at threshold
      expect(
        mod.shouldAutoApprove(
          { decision: 'APPROVE', confidence: 0.85, reason: 'ok' },
          0.85,
        ),
      ).toBe(true);
    });

    it('returns false for APPROVE with low confidence', () => {
      expect(
        mod.shouldAutoApprove(
          { decision: 'APPROVE', confidence: 0.70, reason: 'not sure' },
          0.85,
        ),
      ).toBe(false);
    });

    it('returns false for REJECT regardless of confidence', () => {
      expect(
        mod.shouldAutoApprove(
          { decision: 'REJECT', confidence: 0.99, reason: 'bad' },
          0.85,
        ),
      ).toBe(false);
    });
  });

  describe('runAiReview', () => {
    let redis: ReturnType<typeof createRedisMock>;
    let config: AllowlistConfig;

    beforeEach(() => {
      redis = createRedisMock();
      config = defaultConfig();
    });

    function seedPendingRequest(requestId: string, chatId: number): PendingRequest {
      const request: PendingRequest = {
        request_id: requestId,
        chat_id: chatId,
        user_id: 42,
        username: 'testuser',
        first_name: 'Test',
        note: 'Please review',
        chat_title: 'Test Group',
        created_at: Math.floor(Date.now() / 1000),
        ai_reason: '',
        review_state: 'needs_manual',
      };
      redis.hset('xxb:mal:pending', requestId, JSON.stringify(request));
      return request;
    }

    it('auto-approves when AI confidence meets threshold', async () => {
      seedPendingRequest('req-auto', -500);
      const aiCall = vi.fn(async () =>
        JSON.stringify({ decision: 'APPROVE', confidence: 0.92, reason: 'Good group' }),
      );

      const result = await mod.runAiReview(redis, config, 'req-auto', { aiCall });
      expect(result.ok).toBe(true);
      expect(result.decision).toBe('APPROVE');
      expect(result.enabled_now).toBe(true);

      // Should now be in groups, not pending
      const pendingRaw = await redis.hget('xxb:mal:pending', 'req-auto');
      expect(pendingRaw).toBeNull();

      const groupRaw = await redis.hget('xxb:mal:groups', '-500');
      expect(groupRaw).not.toBeNull();
      const group = JSON.parse(groupRaw!);
      expect(group.approved_by).toBe('ai');
      expect(group.review_state).toBe('auto_approved');
    });

    it('keeps in pending when AI confidence is below threshold', async () => {
      seedPendingRequest('req-low', -501);
      const aiCall = vi.fn(async () =>
        JSON.stringify({ decision: 'APPROVE', confidence: 0.60, reason: 'Unsure' }),
      );

      const result = await mod.runAiReview(redis, config, 'req-low', { aiCall });
      expect(result.ok).toBe(true);
      expect(result.decision).toBe('APPROVE');
      expect(result.enabled_now).toBeUndefined();

      // Should still be in pending
      const pendingRaw = await redis.hget('xxb:mal:pending', 'req-low');
      expect(pendingRaw).not.toBeNull();
      const pending = JSON.parse(pendingRaw!) as PendingRequest;
      expect(pending.review_state).toBe('needs_manual');
      expect(pending.ai_decision).toBe('APPROVE');
    });

    it('handles AI call failure', async () => {
      seedPendingRequest('req-fail', -502);
      const aiCall = vi.fn(async () => null);

      const result = await mod.runAiReview(redis, config, 'req-fail', { aiCall });
      expect(result.ok).toBe(false);
    });

    it('handles unparseable AI response', async () => {
      seedPendingRequest('req-bad', -503);
      const aiCall = vi.fn(async () => 'I cannot decide lol');

      const result = await mod.runAiReview(redis, config, 'req-bad', { aiCall });
      expect(result.ok).toBe(false);
    });

    it('returns ok:false for missing request', async () => {
      const aiCall = vi.fn(async () => 'unused');
      const result = await mod.runAiReview(redis, config, 'nonexistent', { aiCall });
      expect(result.ok).toBe(false);
      expect(aiCall).not.toHaveBeenCalled();
    });
  });
});
