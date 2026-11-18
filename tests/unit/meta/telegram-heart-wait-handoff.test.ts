import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FormattedMessage } from '../../../src/shared/types.js';
import type { AttentionItem } from '../../../src/meta/types.js';
import type { PendingIntentRef } from '../../../src/meta/pending-intent.js';
import type { TelegramHeartCandidate } from '../../../src/meta/telegram-heart-store.js';

const f = vi.hoisted(() => ({ db: undefined as unknown as Database.Database, policy: vi.fn(), timing: vi.fn(),
  answered: vi.fn(), history: vi.fn(), inspect: vi.fn(), binding: vi.fn(), counter: vi.fn(),
  config: { TIMING_GATE_ENABLED: true, META_ACTIVATED_AT_SEC: 1, CODEACT_ISOLATION_ENABLED: true, META_SUBAGENT_ENABLED: true },
}));
vi.mock('../../../src/env.js', () => ({ env: () => f.config }));
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => f.db }));
vi.mock('../../../src/metrics/registry.js', () => ({ incrCounter: f.counter }));
vi.mock('../../../src/meta/answered.js', () => ({ isMessageAnswered: f.answered }));
vi.mock('../../../src/meta/pending-intent.js', () => ({ inspectPendingIntent: f.inspect, pendingIntentForEvent: f.binding }));
vi.mock('../../../src/meta/flags.js', () => ({ isTelegramHeartBatchChat: () => true }));
vi.mock('../../../src/pipeline/timing/chat-runtime.js', () => ({ getChatState: f.timing }));
vi.mock('../../../src/shared/privacy-scope.js', () => ({ resolveConversationScope: () => ({
  platform: 'telegram', accountId: '123', conversationKind: 'group' }) }));
vi.mock('../../../src/meta/telegram-heart-policy.js', () => ({ telegramHeartBatchPolicyCurrent: f.policy }));
vi.mock('../../../src/meta/heart-source-fingerprint.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/meta/heart-source-fingerprint.js')>(), telegramHeartWaitContext: f.history,
}));
import { createMessageEventIdentity } from '../../../src/shared/event-identity.js';
import { acceptTelegramHeartCandidate, checkTelegramHeartClaim, claimTelegramHeartBatch, deferTelegramHeartSources,
  finishTelegramHeartBatch, getTelegramHeartEntry, interruptTelegramHeartScope, telegramHeartScope } from '../../../src/meta/telegram-heart-store.js';
import { captureTelegramHeartWaitFence } from '../../../src/meta/telegram-heart-wait-fence.js';
import { checkTelegramWaitAttention, registerTelegramWaitAttention } from '../../../src/meta/telegram-heart-wait-handoff.js';

const chatId = -100, threadId = 7, messageId = 94, uid = 22;
const ref: PendingIntentRef = { laneKey: 'b', intentId: 'b1', revision: 1, platform: 'telegram', accountId: '123', chatId, threadId, senderId: uid };
let source: FormattedMessage, candidate: TelegramHeartCandidate, event: string;
function bump(): void { f.db.prepare('UPDATE telegram_heart_scope_versions SET version=version+1 WHERE scope_key=?').run(telegramHeartScope(candidate).key); }
function publish(id = 'first', uncertain = false): AttentionItem {
  const entry = getTelegramHeartEntry(event)!;
  const claim = claimTelegramHeartBatch([entry], true)!;
  const item: AttentionItem = { id, createdAt: Date.now(), layer: 'L1', chatId, messageThreadId: threadId, userId: uid, messageId,
    pressure: 70, reason: 'heart:reply', pendingIntent: ref, waitRecovery: captureTelegramHeartWaitFence(chatId, threadId, claim.scopeVersion)!,
    telegramWaitSourceEventId: event };
  expect(checkTelegramHeartClaim(claim, true)).toBe(true);
  expect(registerTelegramWaitAttention(item, source)).toBe(true);
  finishTelegramHeartBatch(claim, uncertain ? 'failed' : 'settled');
  return item;
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(1_000_000);
  f.db = new Database(':memory:');
  for (const file of ['0134_telegram_heart_batches', '0135_telegram_heart_source_wait']) f.db.exec(readFileSync(`migrations/${file}.sql`, 'utf8'));
  f.config.META_ACTIVATED_AT_SEC = 1; f.config.CODEACT_ISOLATION_ENABLED = true;
  f.policy.mockReset().mockResolvedValue(true); f.timing.mockReset().mockResolvedValue({ state: 'RUNNING' });
  f.answered.mockReset().mockResolvedValue(false); f.binding.mockReset().mockReturnValue(ref); f.inspect.mockReset().mockReturnValue({ state: 'pending', currentRevision: 1 });
  source = { messageId, uid, messageThreadId: threadId, username: '', fullName: '乙', isForwarded: false, role: 'user',
    textContent: '从哪个门进？', replyTo: { messageId: 80, uid: 33, fullName: '群友', textSnippet: '场馆安排' }, timestamp: Date.now() / 1000,
    pendingIntent: ref, eventIdentity: createMessageEventIdentity({ ref: { id: String(messageId), conversation: {
      platform: 'telegram', idNamespace: 'telegram', accountId: '123', conversationKind: 'group', id: String(chatId), threadId: String(threadId) } }, occurredAt: Date.now() }) };
  event = source.eventIdentity!.eventId;
  f.history.mockReset().mockResolvedValue([source]);
  candidate = { chatId, layer: 'L2', addressed: false, formatted: source };
  const accepted = acceptTelegramHeartCandidate(candidate)!;
  const claim = claimTelegramHeartBatch([accepted])!;
  expect(deferTelegramHeartSources(claim, [messageId], 1)).toBe(true); finishTelegramHeartBatch(claim, 'settled');
  vi.advanceTimersByTime(1000);
});
afterEach(() => { f.db.close(); vi.useRealTimers(); });

describe('the single pre-Meta reconsideration of a Telegram source WAIT', () => {
  it('reclaims the verified physical source once across duplicate reads and retains its original layer and quote', async () => {
    const item = publish(); bump();
    expect(await Promise.all([checkTelegramWaitAttention(item, false), checkTelegramWaitAttention(item, true)])).toEqual([false, false]);
    expect(getTelegramHeartEntry(event)?.item).toMatchObject({ layer: 'L2', formatted: { messageId, uid, replyTo: { messageId: 80, uid: 33 } } });
    const second = publish('second');
    expect(await checkTelegramWaitAttention(item, true)).toBe(false);
    expect(await checkTelegramWaitAttention(second, false)).toBe(true); bump();
    expect(await checkTelegramWaitAttention(second, true)).toBe(false);
    expect(getTelegramHeartEntry(event)?.state).toBe('settled');
  });

  it('preserves known busy re-entry while current and closes all recovery after session entry', async () => {
    const item = publish();
    expect(await checkTelegramWaitAttention(item, true)).toBe(true);
    expect(await checkTelegramWaitAttention(item, true)).toBe(true);
    bump(); expect(await checkTelegramWaitAttention(item, false)).toBe(false);
    expect(getTelegramHeartEntry(event)?.state).toBe('settled');
  });

  it.each(['direct interrupt', 'STOP', 'answered', 'unknown', 'expired', 'missing source', 'different quote', 'different owner',
    'wrong topic', 'intent changed', 'policy withdrawn', 'activation changed', 'isolation disabled', 'wrong ticket', 'unavailable'])('keeps %s closed after new passive traffic', async why => {
    let item = publish('first', why === 'unknown');
    if (why === 'direct interrupt') interruptTelegramHeartScope(telegramHeartScope(candidate));
    if (why === 'STOP') f.timing.mockResolvedValue({ state: 'STOP' });
    if (why === 'answered') f.answered.mockResolvedValue(true);
    if (why === 'expired') vi.advanceTimersByTime(300_000);
    if (why === 'missing source') f.history.mockResolvedValue([]);
    if (why === 'different quote') f.history.mockResolvedValue([{ ...source, replyTo: undefined }]);
    if (why === 'different owner') f.history.mockResolvedValue([{ ...source, uid: 99 }]);
    if (why === 'wrong topic') item = { ...item, messageThreadId: 8 };
    if (why === 'intent changed') f.inspect.mockReturnValue({ state: 'pending', currentRevision: 2 });
    if (why === 'policy withdrawn') f.policy.mockResolvedValue(false);
    if (why === 'activation changed') f.config.META_ACTIVATED_AT_SEC = 2;
    if (why === 'isolation disabled') f.config.CODEACT_ISOLATION_ENABLED = false;
    if (why === 'wrong ticket') item = { ...item, id: 'other' };
    if (why === 'unavailable') f.answered.mockRejectedValue(new Error('receipt unavailable'));
    bump(); expect(await checkTelegramWaitAttention(item, true)).toBe(false);
    expect(getTelegramHeartEntry(event)?.state).toBe(why === 'unknown' ? 'unknown' : 'settled');
  });
});
