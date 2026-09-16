import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Redis } from 'ioredis';
import type { AllowlistConfig, GroupRecord, PendingRequest } from '../../../src/allowlist/types.js';

// Mock logger
vi.mock('../../../src/shared/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// In-memory Redis mock
function createRedisMock() {
  const store = new Map<string, Map<string, string>>();
  const counters = new Map<string, number>();
  const ttls = new Map<string, number>();

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
    set: vi.fn(async (key: string, value: string, ...args: unknown[]) => {
      // Support NX flag: return null if key exists
      const hasNx = args.some((a) => typeof a === 'string' && a.toUpperCase() === 'NX');
      if (hasNx && counters.has(`__str:${key}`)) return null;
      counters.set(`__str:${key}`, 1);
      // Handle EX for TTL (just store, no actual expiry in mock)
      return 'OK';
    }),
    del: vi.fn(async (key: string) => {
      counters.delete(`__str:${key}`);
      store.delete(key);
      return 1;
    }),
    incr: vi.fn(async (key: string) => {
      const val = (counters.get(key) ?? 0) + 1;
      counters.set(key, val);
      return val;
    }),
    expire: vi.fn(async (key: string, seconds: number) => {
      ttls.set(key, seconds);
      return 1;
    }),
    _store: store,
    _counters: counters,
  };

  return mock as unknown as Redis & typeof mock;
}

function defaultConfig(overrides: Partial<AllowlistConfig> = {}): AllowlistConfig {
  return {
    enabled: true,
    redisPrefix: 'xxb:mal:',
    defaultEnabledAfterApproval: true,
    maxSubmissionsPerUserPerDay: 3,
    autoAiReviewOnSubmit: false,
    autoAiReviewMessageLimit: 50,
    aiReviewContextMaxChars: 5000,
    aiApproveAutoEnable: true,
    aiApproveConfidenceThreshold: 0.85,
    ...overrides,
  };
}

// Lazy import so mocks are applied first
async function importAllowlist() {
  return await import('../../../src/allowlist/allowlist.js');
}

describe('allowlist', () => {
  let redis: ReturnType<typeof createRedisMock>;
  let config: AllowlistConfig;
  let al: Awaited<ReturnType<typeof importAllowlist>>;

  beforeEach(async () => {
    redis = createRedisMock();
    config = defaultConfig();
    al = await importAllowlist();
  });

  describe('isGroupAllowed', () => {
    it('returns true when allowlist is disabled', async () => {
      config = defaultConfig({ enabled: false });
      const result = await al.isGroupAllowed(redis, config, -100123);
      expect(result).toBe(true);
    });

    it('returns false for unknown group', async () => {
      const result = await al.isGroupAllowed(redis, config, -999999);
      expect(result).toBe(false);
    });

    it('returns true for approved+enabled group', async () => {
      const group: GroupRecord = {
        chat_id: -100123,
        approved: true,
        enabled: true,
        approved_by: 'admin',
        approved_at: 1000,
        title: 'Test Group',
        last_request_id: 'abc',
        submitter_user_id: 42,
        review_state: 'manual_approved',
        ai_reason: '',
        updated_at: 1000,
      };
      await redis.hset('xxb:mal:groups', '-100123', JSON.stringify(group));
      const result = await al.isGroupAllowed(redis, config, -100123);
      expect(result).toBe(true);
    });

    it('returns false for approved but disabled group', async () => {
      const group: GroupRecord = {
        chat_id: -100123,
        approved: true,
        enabled: false,
        approved_by: 'admin',
        approved_at: 1000,
        title: 'Test Group',
        last_request_id: 'abc',
        submitter_user_id: 42,
        review_state: 'manual_approved',
        ai_reason: '',
        updated_at: 1000,
      };
      await redis.hset('xxb:mal:groups', '-100123', JSON.stringify(group));
      const result = await al.isGroupAllowed(redis, config, -100123);
      expect(result).toBe(false);
    });
  });

  describe('submit', () => {
    it('creates pending request', async () => {
      const result = await al.submit(redis, config, {
        chatId: -100200,
        userId: 42,
        username: 'testuser',
        firstName: 'Test',
        note: 'Please add',
        chatTitle: 'My Group',
      });
      expect(result.ok).toBe(true);
      expect(result.request_id).toBeDefined();
      expect(result.request_id!.length).toBe(32); // hex(16 bytes) = 32 chars

      // Verify pending entry exists
      const pending = await al.listPending(redis, config);
      expect(pending).toHaveLength(1);
      expect(pending[0]!.chat_id).toBe(-100200);
      expect(pending[0]!.review_state).toBe('needs_manual');
    });

    it('returns rate_limited when exceeding daily limit', async () => {
      for (let i = 0; i < config.maxSubmissionsPerUserPerDay; i++) {
        await al.submit(redis, config, {
          chatId: -(100300 + i),
          userId: 42,
          note: 'test',
          chatTitle: `Group ${i}`,
        });
      }

      const result = await al.submit(redis, config, {
        chatId: -100400,
        userId: 42,
        note: 'test',
        chatTitle: 'One More Group',
      });
      expect(result.ok).toBe(false);
      expect(result.error).toBe('rate_limited');
    });

    it('returns already_registered for existing group', async () => {
      const group: GroupRecord = {
        chat_id: -100500,
        approved: true,
        enabled: true,
        approved_by: 'admin',
        approved_at: 1000,
        title: 'Existing',
        last_request_id: 'x',
        submitter_user_id: 42,
        review_state: 'manual_approved',
        ai_reason: '',
        updated_at: 1000,
      };
      await redis.hset('xxb:mal:groups', '-100500', JSON.stringify(group));

      const result = await al.submit(redis, config, {
        chatId: -100500,
        userId: 99,
        note: 'add me',
        chatTitle: 'Existing',
      });
      expect(result.ok).toBe(false);
      expect(result.error).toBe('already_registered');
    });

    it('returns already_pending for duplicate pending', async () => {
      await al.submit(redis, config, {
        chatId: -100600,
        userId: 42,
        note: 'first',
        chatTitle: 'Pending Group',
      });

      const result = await al.submit(redis, config, {
        chatId: -100600,
        userId: 99,
        note: 'second',
        chatTitle: 'Pending Group',
      });
      expect(result.ok).toBe(false);
      expect(result.error).toBe('already_pending');
    });
  });

  describe('approveRequest', () => {
    it('moves pending to groups', async () => {
      const submitResult = await al.submit(redis, config, {
        chatId: -100700,
        userId: 42,
        username: 'bob',
        firstName: 'Bob',
        note: 'please',
        chatTitle: 'Bob Group',
      });
      const requestId = submitResult.request_id!;

      const result = await al.approveRequest(redis, config, requestId, 'admin_user');
      expect(result.ok).toBe(true);
      expect(result.chat_id).toBe(-100700);
      expect(result.enabled).toBe(true);

      // Pending should be empty
      const pending = await al.listPending(redis, config);
      expect(pending).toHaveLength(0);

      // Group should exist
      const group = await al.getGroupRecord(redis, config, -100700);
      expect(group).not.toBeNull();
      expect(group!.approved).toBe(true);
      expect(group!.enabled).toBe(true);
      expect(group!.approved_by).toBe('admin_user');
      expect(group!.review_state).toBe('manual_approved');
    });

    it('returns ok:false for missing request', async () => {
      const result = await al.approveRequest(redis, config, 'nonexistent', 'admin');
      expect(result.ok).toBe(false);
    });
  });

  describe('rejectRequest', () => {
    it('moves pending to reviewed', async () => {
      const submitResult = await al.submit(redis, config, {
        chatId: -100800,
        userId: 42,
        note: 'test',
        chatTitle: 'Reject Group',
      });
      const requestId = submitResult.request_id!;

      const rejected = await al.rejectRequest(redis, config, requestId);
      expect(rejected).toBe(true);

      // Pending should be empty
      const pending = await al.listPending(redis, config);
      expect(pending).toHaveLength(0);

      // Reviewed should have the request
      const reviewedAll = await redis.hgetall('xxb:mal:reviewed');
      expect(Object.keys(reviewedAll)).toHaveLength(1);
      const reviewed = JSON.parse(Object.values(reviewedAll)[0]!) as PendingRequest;
      expect(reviewed.chat_id).toBe(-100800);
    });
  });

  describe('setGroupEnabled', () => {
    it('toggles enabled flag', async () => {
      const group: GroupRecord = {
        chat_id: -100900,
        approved: true,
        enabled: true,
        approved_by: 'admin',
        approved_at: 1000,
        title: 'Toggle',
        last_request_id: 'x',
        submitter_user_id: 42,
        review_state: 'manual_approved',
        ai_reason: '',
        updated_at: 1000,
      };
      await redis.hset('xxb:mal:groups', '-100900', JSON.stringify(group));

      const result = await al.setGroupEnabled(redis, config, -100900, false);
      expect(result).toBe(true);

      const updated = await al.getGroupRecord(redis, config, -100900);
      expect(updated!.enabled).toBe(false);
    });
  });

  describe('removeGroup', () => {
    it('deletes from groups hash', async () => {
      const group: GroupRecord = {
        chat_id: -101000,
        approved: true,
        enabled: true,
        approved_by: 'admin',
        approved_at: 1000,
        title: 'Remove',
        last_request_id: 'x',
        submitter_user_id: 42,
        review_state: 'manual_approved',
        ai_reason: '',
        updated_at: 1000,
      };
      await redis.hset('xxb:mal:groups', '-101000', JSON.stringify(group));

      const result = await al.removeGroup(redis, config, -101000);
      expect(result).toBe(true);

      const gone = await al.getGroupRecord(redis, config, -101000);
      expect(gone).toBeNull();
    });
  });

  describe('listPending', () => {
    it('returns all pending requests', async () => {
      await al.submit(redis, config, {
        chatId: -200001,
        userId: 1,
        note: 'a',
        chatTitle: 'A',
      });
      await al.submit(redis, config, {
        chatId: -200002,
        userId: 2,
        note: 'b',
        chatTitle: 'B',
      });

      const pending = await al.listPending(redis, config);
      expect(pending).toHaveLength(2);
    });
  });

  describe('listManualQueue', () => {
    it('filters to needs_manual', async () => {
      // Create a pending request with needs_manual
      await al.submit(redis, config, {
        chatId: -200003,
        userId: 1,
        note: 'manual',
        chatTitle: 'Manual',
      });

      // Create another and change its state to auto_approved
      const autoResult = await al.submit(redis, config, {
        chatId: -200004,
        userId: 2,
        note: 'auto',
        chatTitle: 'Auto',
      });
      const raw = await redis.hget('xxb:mal:pending', autoResult.request_id!);
      const req = JSON.parse(raw!) as PendingRequest;
      req.review_state = 'auto_approved';
      await redis.hset('xxb:mal:pending', autoResult.request_id!, JSON.stringify(req));

      const manual = await al.listManualQueue(redis, config);
      expect(manual).toHaveLength(1);
      expect(manual[0]!.chat_title).toBe('Manual');
    });
  });

  describe('listGroups', () => {
    it('returns all approved groups', async () => {
      for (let i = 0; i < 3; i++) {
        const group: GroupRecord = {
          chat_id: -(300000 + i),
          approved: true,
          enabled: true,
          approved_by: 'admin',
          approved_at: 1000,
          title: `G${i}`,
          last_request_id: `r${i}`,
          submitter_user_id: 42,
          review_state: 'manual_approved',
          ai_reason: '',
          updated_at: 1000,
        };
        await redis.hset('xxb:mal:groups', String(group.chat_id), JSON.stringify(group));
      }

      const groups = await al.listGroups(redis, config);
      expect(groups).toHaveLength(3);
    });
  });

  describe('listByUser', () => {
    it('filters by userId', async () => {
      // Submit from user 42
      await al.submit(redis, config, {
        chatId: -400001,
        userId: 42,
        note: 'mine',
        chatTitle: 'My Group',
      });
      // Submit from user 99
      await al.submit(redis, config, {
        chatId: -400002,
        userId: 99,
        note: 'theirs',
        chatTitle: 'Their Group',
      });

      const byUser = await al.listByUser(redis, config, 42);
      expect(byUser.pending).toHaveLength(1);
      expect(byUser.pending[0]!.chat_id).toBe(-400001);
      expect(byUser.groups).toHaveLength(0);
      expect(byUser.reviewed).toHaveLength(0);
    });
  });
});
