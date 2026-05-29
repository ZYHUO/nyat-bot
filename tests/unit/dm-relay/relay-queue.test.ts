import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

let testDb: Database.Database;

vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => testDb }));
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => ({}) }));
vi.mock('../../../src/pipeline/context/manager.js', () => ({
  getUserGroups: vi.fn().mockResolvedValue([]),
  getGroupMembers: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../../src/bot/sender/telegram.js', () => ({ sendMessage: vi.fn() }));
vi.mock('../../../src/pipeline/dm-relay/safety.js', () => ({ recheckDeliverySafety: vi.fn() }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const {
  enqueueRelay,
  getPendingRelayForTarget,
  getDueScheduledRelays,
  deliverRelay,
  cancelRelay,
  expireOldRelays,
  setRelayStatus,
} = await import('../../../src/pipeline/dm-relay/relay-queue.js');

function initSchema(db: Database.Database): void {
  db.exec(readFileSync(resolve(process.cwd(), 'migrations/0019_dm_enhancements.sql'), 'utf-8'));
}

const now = () => Math.floor(Date.now() / 1000);

describe('relay-queue', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    initSchema(testDb);
  });
  afterEach(() => testDb.close());

  it('enqueues a relay and returns a positive id', () => {
    const id = enqueueRelay({
      sender_id: 1, target_id: 2, group_id: -100, content: 'hi',
      trigger_mode: 'on_speak', expires_at: now() + 86400,
    });
    expect(id).toBeGreaterThan(0);
  });

  it('rate-limits at 10 pending relays per sender (11th returns -1)', () => {
    for (let i = 0; i < 10; i++) {
      const id = enqueueRelay({
        sender_id: 1, target_id: 2, group_id: -100, content: `m${i}`,
        trigger_mode: 'on_speak', expires_at: now() + 86400,
      });
      expect(id).toBeGreaterThan(0);
    }
    expect(enqueueRelay({
      sender_id: 1, target_id: 2, group_id: -100, content: 'overflow',
      trigger_mode: 'on_speak', expires_at: now() + 86400,
    })).toBe(-1);
  });

  it('getPendingRelayForTarget returns ONLY on_speak relays (not scheduled)', () => {
    enqueueRelay({ sender_id: 1, target_id: 2, group_id: -100, content: 'speak', trigger_mode: 'on_speak', expires_at: now() + 86400 });
    enqueueRelay({ sender_id: 1, target_id: 2, group_id: -100, content: 'sched', trigger_mode: 'scheduled', scheduled_at: now() + 60, expires_at: now() + 86400 });

    const pending = getPendingRelayForTarget(2, -100);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.content).toBe('speak');
    expect(pending[0]!.trigger_mode).toBe('on_speak');
  });

  it('getDueScheduledRelays returns only past-due, pending, scheduled relays', () => {
    enqueueRelay({ sender_id: 1, target_id: 2, group_id: -100, content: 'past', trigger_mode: 'scheduled', scheduled_at: now() - 10, expires_at: now() + 86400 });
    enqueueRelay({ sender_id: 1, target_id: 2, group_id: -100, content: 'future', trigger_mode: 'scheduled', scheduled_at: now() + 3600, expires_at: now() + 86400 });
    enqueueRelay({ sender_id: 1, target_id: 2, group_id: -100, content: 'speak', trigger_mode: 'on_speak', expires_at: now() + 86400 });

    const due = getDueScheduledRelays(now());
    expect(due).toHaveLength(1);
    expect(due[0]!.content).toBe('past');
  });

  it('deliverRelay is atomic — second call returns false', () => {
    const id = enqueueRelay({ sender_id: 1, target_id: 2, group_id: -100, content: 'x', trigger_mode: 'on_speak', expires_at: now() + 86400 });
    expect(deliverRelay(id)).toBe(true);
    expect(deliverRelay(id)).toBe(false);
    expect(getPendingRelayForTarget(2, -100)).toHaveLength(0);
  });

  it('cancelRelay only cancels the sender’s own pending relay', () => {
    const id = enqueueRelay({ sender_id: 1, target_id: 2, group_id: -100, content: 'x', trigger_mode: 'on_speak', expires_at: now() + 86400 });
    expect(cancelRelay(id, 999)).toBe(false); // wrong sender
    expect(cancelRelay(id, 1)).toBe(true);
    expect(cancelRelay(id, 1)).toBe(false); // already cancelled
  });

  it('setRelayStatus forces a status and removes it from pending queries', () => {
    const id = enqueueRelay({ sender_id: 1, target_id: 2, group_id: -100, content: 'x', trigger_mode: 'on_speak', expires_at: now() + 86400 });
    setRelayStatus(id, 'cancelled');
    expect(getPendingRelayForTarget(2, -100)).toHaveLength(0);
  });

  it('expireOldRelays expires only past-deadline pending relays', () => {
    enqueueRelay({ sender_id: 1, target_id: 2, group_id: -100, content: 'old', trigger_mode: 'on_speak', expires_at: now() - 10 });
    enqueueRelay({ sender_id: 1, target_id: 2, group_id: -100, content: 'fresh', trigger_mode: 'on_speak', expires_at: now() + 86400 });
    expect(expireOldRelays()).toBe(1);
    const pending = getPendingRelayForTarget(2, -100);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.content).toBe('fresh');
  });
});
