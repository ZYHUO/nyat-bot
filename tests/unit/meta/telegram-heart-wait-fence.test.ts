import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const f = vi.hoisted(() => ({
  db: undefined as unknown as Database.Database, enabled: true, isolation: true, epoch: 1, account: '123',
  readTiming: vi.fn(), hold: vi.fn(), release: vi.fn(),
}));
vi.mock('../../../src/env.js', () => ({ env: () => ({ TIMING_GATE_ENABLED: true, META_SUBAGENT_ENABLED: true,
  CODEACT_ISOLATION_ENABLED: f.isolation, META_ACTIVATED_AT_SEC: f.epoch }) }));
vi.mock('../../../src/meta/flags.js', () => ({ isTelegramHeartBatchChat: () => f.enabled }));
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => f.db }));
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => ({ hgetall: f.readTiming, hsetnx: f.hold, eval: f.release }) }));
vi.mock('../../../src/shared/privacy-scope.js', () => ({ resolveConversationScope: () => ({
  platform: 'telegram', accountId: f.account, conversationKind: 'group',
}) }));
vi.mock('../../../src/pipeline/timing/chat-runtime.js', async () => ({
  getChatState: (await import('../../../src/pipeline/timing/state-store.js')).getChatState,
}));
import { telegramHeartScopeKey } from '../../../src/meta/telegram-heart-store.js';
import { captureTelegramHeartWaitFence } from '../../../src/meta/telegram-heart-wait-fence.js';
import { isTaskWaitRecoveryCurrent, selectWaitRecovery } from '../../../src/meta/wait-recovery-fence.js';
import { withCodeActDeliveryIntent } from '../../../src/subagent/delivery-hold.js';

const chatId = -100, threadId = 7;
function bump(thread = threadId): void {
  f.db.prepare(`INSERT INTO telegram_heart_scope_versions(scope_key,version) VALUES(?,1)
    ON CONFLICT(scope_key) DO UPDATE SET version=version+1`).run(telegramHeartScopeKey(f.account, chatId, thread));
}
function approved() {
  bump();
  return captureTelegramHeartWaitFence(chatId, threadId, 1)!;
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(100_000);
  f.account = '123'; f.enabled = true; f.isolation = true; f.epoch = 1;
  f.readTiming.mockReset().mockResolvedValue({}); f.hold.mockReset().mockResolvedValue(1); f.release.mockReset().mockResolvedValue(1);
  f.db = new Database(':memory:');
  for (const name of ['0134_telegram_heart_batches', '0135_telegram_heart_source_wait']) {
    f.db.exec(readFileSync(`migrations/${name}.sql`, 'utf8'));
  }
});
afterEach(() => { f.db.close(); vi.useRealTimers(); });

describe('delivery authority for a re-evaluated Telegram source', () => {
  it('requires the version originally read on claim, and ignores another topic’s traffic', async () => {
    expect(captureTelegramHeartWaitFence(chatId, threadId, 1)).toBeUndefined();
    const waitRecovery = approved(), task = { chatId, messageThreadId: threadId, waitRecovery };
    expect(waitRecovery.authority).toBe('telegram_source');
    expect(captureTelegramHeartWaitFence(chatId, threadId)).toBeUndefined();
    bump(8);
    expect(await isTaskWaitRecoveryCurrent(task)).toBe(true);
    bump();
    expect(captureTelegramHeartWaitFence(chatId, threadId, 1)).toBeUndefined();
    expect(await isTaskWaitRecoveryCurrent(task)).toBe(false);
  });

  it('refuses changed account, rollout, timing state, missing storage and expired approval', async () => {
    const task = { chatId, messageThreadId: threadId, waitRecovery: approved() };
    f.account = '124'; expect(await isTaskWaitRecoveryCurrent(task)).toBe(false); f.account = '123';
    f.enabled = false; expect(await isTaskWaitRecoveryCurrent(task)).toBe(false); f.enabled = true;
    f.isolation = false; expect(await isTaskWaitRecoveryCurrent(task)).toBe(false); f.isolation = true;
    f.epoch = 2; expect(await isTaskWaitRecoveryCurrent(task)).toBe(false); f.epoch = 1;
    f.readTiming.mockRejectedValueOnce(new Error('fixture outage'));
    expect(await isTaskWaitRecoveryCurrent(task)).toBe(false);
    for (const state of ['STOP', 'WAIT', 'invalid']) {
      f.readTiming.mockResolvedValueOnce({ state }); expect(await isTaskWaitRecoveryCurrent(task)).toBe(false);
    }
    vi.setSystemTime(task.waitRecovery.expiresAt); expect(await isTaskWaitRecoveryCurrent(task)).toBe(false);
    vi.setSystemTime(100_000); f.db.exec('DROP TABLE telegram_heart_scope_versions');
    expect(await isTaskWaitRecoveryCurrent(task)).toBe(false);
  });

  it('keeps the earliest expiry across real quote sources, and rejects mixed authorities', () => {
    const fence = approved();
    const one = { chatId, messageThreadId: threadId, messageId: 10, waitRecovery: fence };
    const two = { ...one, messageId: 11, waitRecovery: { ...fence, expiresAt: fence.expiresAt + 100 } };
    expect(selectWaitRecovery([two, one], chatId, threadId, [10, 11])).toEqual(fence);
    const legacy = { chatId, messageThreadId: threadId, messageId: 11,
      waitRecovery: { accountId: fence.accountId, platform: fence.platform, chatId, threadId, generation: fence.generation } };
    expect(() => selectWaitRecovery([one, legacy], chatId, threadId, [10, 11])).toThrow('wait_recovery_source_mismatch');
  });

  it('vetoes the platform call if new input arrives while claiming the delivery', async () => {
    const waitRecovery = approved(), send = vi.fn(async () => 555);
    f.hold.mockImplementationOnce(async () => { bump(); return 1; });
    await expect(withCodeActDeliveryIntent('task', chatId, send, { waitRecovery, messageThreadId: threadId }))
      .rejects.toMatchObject({ code: 'wait_recovery_stale', delivery: 'not_sent' });
    expect(send).not.toHaveBeenCalled(); expect(f.release).toHaveBeenCalledOnce();
  });
});
