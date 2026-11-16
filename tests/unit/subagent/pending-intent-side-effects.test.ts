import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeliveryIntentRedis } from '../../helpers/delivery-intent-redis.js';
import { createMessageEventIdentity } from '../../../src/shared/event-identity.js';
import { observePendingIntent, settlePendingIntent } from '../../../src/meta/pending-intent.js';
import { DELIVERY_HOLD_KEY } from '../../../src/subagent/delivery-hold.js';

const f = vi.hoisted(() => ({ db: null as unknown as Database.Database,
  llm: vi.fn(), createGoal: vi.fn(), createDebt: vi.fn(), send: vi.fn(), reaction: vi.fn(), end: vi.fn(), unknown: vi.fn(),
  claim: vi.fn(), context: vi.fn(), cfg: { BOT_TOKEN: '12345:synthetic', META_PENDING_INTENT_ENABLED: true,
    PROMISE_LOOP_ENABLED: true, PROMISE_CHECK_USAGE: 'synthetic', GOAL_MAX_ACTIVE: 20,
    CODEACT_BANNED_WORDS: [], MEMORY_SENSITIVE_CHAT_IDS: [], ONEBOT_MEDIA_ENABLED: false } }));
const redis = createDeliveryIntentRedis();
// This ordinary-task fixture has no owner assignment; durable grant behavior
// is exercised separately with the real assignment store and its migrations.
vi.mock('../../../src/platform/onebot-assignment-store.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/platform/onebot-assignment-store.js')>(),
  assertOneBotAssignmentTask: () => null,
}));
vi.mock('../../../src/env.js', () => ({ env: () => f.cfg }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => f.db }));
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => ({ ...redis, hsetnx: f.claim,
  get: async () => null, set: async () => 'OK', zadd: async () => 1, lrange: async () => [],
  eval: async (...args: Parameters<typeof redis.eval>) => {
    if (args[2].startsWith('xxb:ctx:')) { f.context(args[2], JSON.parse(args[3])); return 1; }
    return redis.eval(...args);
  } }) }));
vi.mock('../../../src/ai/fallback.js', () => ({ callWithFallback: f.llm }));
vi.mock('../../../src/agent/goals.js', () => ({ createGoal: f.createGoal }));
vi.mock('../../../src/agent/cognitive-debts.js', () => ({ createDebt: f.createDebt }));
vi.mock('../../../src/agent/task-progress.js', () => ({ markTaskVisible: vi.fn() }));
vi.mock('../../../src/agent/predictions.js', () => ({ recordPrediction: vi.fn() }));
vi.mock('../../../src/agent/social-predictions.js', () => ({ recordSocialDeliveryPrediction: vi.fn() }));
vi.mock('../../../src/platform/onebot-notices.js', () => ({ isOneBotMessageRecalled: () => false }));
vi.mock('../../../src/bot/bot.js', () => ({ getBot: () => ({ api: { setMessageReaction: f.reaction } }),
  getBotUid: () => 12345, getBotDisplayName: () => 'Synthetic', getBotIdentity: () => ({ uid: 12345, username: '', nicknames: [] }) }));
// Keep the real reaction sender and final Telegram API boundary. Only synthetic
// text ACKs are stubbed to establish the promise which the backstop observes.
vi.mock('../../../src/bot/sender/telegram.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/bot/sender/telegram.js')>(),
  sendMessage: f.send, sendChatAction: async () => undefined,
}));
vi.mock('../../../src/meta/answered.js', () => ({ answeredTimestamps: async () => [], markMessageAnswered: async () => undefined }));
vi.mock('../../../src/meta/session-digest.js', () => ({ persistDigest: vi.fn(), searchDigests: () => [] }));
vi.mock('../../../src/meta/timing-adapter.js', () => ({ noteMetaBotReply: async () => undefined }));
vi.mock('../../../src/subagent/post-task-window.js', () => ({ noteBotSpoke: vi.fn() }));
vi.mock('../../../src/tracking/self-history.js', () => ({ recordSelfReply: vi.fn(), getRecentBotTextsInChat: () => [] }));
vi.mock('../../../src/metrics/social-ledger.js', () => ({ recordReplySent: vi.fn() }));
vi.mock('../../../src/metrics/registry.js', () => ({ incrCounter: vi.fn() }));
vi.mock('../../../src/memory/chroma.js', () => ({ searchMemory: async () => [], searchMemoryByUser: async () => [],
  searchOwnerMemory: async () => [], memorizeAcknowledgedDelivery: vi.fn() }));
vi.mock('../../../src/knowledge/sticker/store.js', () => ({ getReadyStickersByIntent: () => [] }));
vi.mock('../../../src/tracking/person-identity.js', () => ({ getPersonIdentity: () => null, buildCrossGroupInjection: () => '' }));
vi.mock('../../../src/pipeline/reply/anti-repeat.js', () => ({ checkNearDuplicate: async () => ({ isNearDuplicate: false }) }));
vi.mock('../../../src/pipeline/reply/segmenter.js', () => ({ REPLY_SPLIT_CHAR_THRESHOLD: 1000,
  segmentReply: (text: string) => ({ segments: [text] }), calculateTypingDelay: () => 0 }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function source(messageId: number, text: string) {
  return observePendingIntent(20, { role: 'user', uid: 20, username: '', fullName: 'Synthetic',
    timestamp: Date.now() / 1000, messageId, textContent: text, isForwarded: false,
    eventIdentity: createMessageEventIdentity({ ref: { conversation: { platform: 'telegram', accountId: '12345',
      idNamespace: 'telegram', conversationKind: 'private', id: '20' }, id: String(messageId) }, occurredAt: Date.now(), content: text }) })!;
}
async function host() {
  const { createHostApi } = await import('../../../src/subagent/host-api.js');
  const pendingIntent = source(1, '稍后查一下合成问题');
  return { pendingIntent, api: createHostApi(20, { taskId: 'synthetic-intent', targetUserId: 20, defaultReplyTo: 1,
    pendingIntent, onEnd: f.end, onDeliveryUnknown: f.unknown }) };
}

beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); redis.reset();
  f.db = new Database(':memory:'); f.db.exec(readFileSync('migrations/0129_pending_reply_intents.sql', 'utf8'));
  f.claim.mockImplementation(redis.hsetnx);
  f.createGoal.mockReturnValue(7); f.reaction.mockResolvedValue(true);
  f.context.mockResolvedValue(undefined);
  f.send.mockImplementation(async (_chat, _text, _reply, _thread, options) => { options.beforeSend(); return 9001; });
  f.llm.mockResolvedValue({ content: '{"promise":true,"topic":"查合成问题的状态"}' });
});
afterEach(() => { f.db.close(); });

describe('pending intent fences at delayed host side effects', () => {
  it('cancellation while Redis claims the delivery makes zero real reaction API calls and clears the exact intent', async () => {
    const claimed = deferred<void>(), release = deferred<void>();
    f.claim.mockImplementation(async (...args: Parameters<typeof redis.hsetnx>) => {
      const result = await redis.hsetnx(...args); claimed.resolve(); await release.promise; return result;
    });
    const { api } = await host();
    const pending = api.telegram.react(1, '👍');
    const rejected = expect(pending).rejects.toMatchObject({ code: 'delivery_fence_changed', delivery: 'not_sent' });
    await claimed.promise; source(2, '不用了'); release.resolve();
    await rejected;
    expect(f.reaction).not.toHaveBeenCalled(); expect(f.unknown).not.toHaveBeenCalled();
    expect(await redis.hget(DELIVERY_HOLD_KEY, 'synthetic-intent')).toBeNull();
  });

  it('an unchanged draft can react once through the same durable claim', async () => {
    const { api } = await host();
    await expect(api.telegram.react(1, '👍')).resolves.toBe(true);
    expect(f.reaction).toHaveBeenCalledExactlyOnceWith(20, 1, [{ type: 'emoji', emoji: '👍' }]);
    expect(await redis.hget(DELIVERY_HOLD_KEY, 'synthetic-intent')).toBeNull();
  });

  it.each(['failed_input_superseded', 'failed_user_stopped', 'user_stopped'])('terminal %s never starts promise recovery', async summary => {
    const { api } = await host(); await api.telegram.sendText('等下本喵查完告诉你');
    api.runtime.endTask(summary); await api.runtime.flushBookkeeping();
    expect(f.llm).not.toHaveBeenCalled(); expect(f.createGoal).not.toHaveBeenCalled(); expect(f.createDebt).not.toHaveBeenCalled();
    expect(f.context).toHaveBeenCalledWith('xxb:ctx:v2:["telegram","12345",20,"private",0]', expect.objectContaining({ messageId: 9001,
      contextScope: { platform: 'telegram', accountId: '12345', chatId: 20, conversationKind: 'private', threadId: 0 },
    }));
  });

  it('a stale endTask does not start recovery even if its summary claims done', async () => {
    const { api } = await host(); await api.telegram.sendText('等下本喵查完告诉你');
    source(2, '改成另一个问题'); api.runtime.endTask('done'); await api.runtime.flushBookkeeping();
    expect(f.llm).not.toHaveBeenCalled(); expect(f.createGoal).not.toHaveBeenCalled();
  });

  it.each(['不用了', '改成另一个问题'])('input change during promise evaluation (%s) cannot create a goal or debt', async control => {
    const started = deferred<void>(), response = deferred<{ content: string }>();
    f.llm.mockImplementation(() => { started.resolve(); return response.promise; });
    const { api } = await host(); await api.telegram.sendText('等下本喵查完告诉你');
    api.runtime.endTask('done'); await started.promise;
    source(2, control); response.resolve({ content: '{"promise":true,"topic":"查合成问题的状态"}' });
    await api.runtime.flushBookkeeping();
    expect(f.createGoal).not.toHaveBeenCalled(); expect(f.createDebt).not.toHaveBeenCalled();
    expect(f.send).toHaveBeenCalledOnce();
  });

  it('joins a valid promise check before terminal settlement instead of dropping legitimate follow-up', async () => {
    const started = deferred<void>(), response = deferred<{ content: string }>();
    f.llm.mockImplementation(() => { started.resolve(); return response.promise; });
    const { api, pendingIntent } = await host(); await api.telegram.sendText('等下本喵查完告诉你');
    api.runtime.endTask('done'); await started.promise;
    let flushed = false;
    const draining = api.runtime.flushBookkeeping().then(() => { flushed = true; });
    await Promise.resolve(); expect(flushed).toBe(false);
    response.resolve({ content: '{"promise":true,"topic":"查合成问题的状态"}' }); await draining;
    settlePendingIntent(pendingIntent);
    expect(f.createGoal).toHaveBeenCalledOnce(); expect(f.createDebt).toHaveBeenCalledOnce();
    expect(f.createGoal).toHaveBeenCalledWith(expect.objectContaining({ chatId: 20, origin: 'promise-backstop:synthetic-intent' }), 20);
    expect(f.send).toHaveBeenCalledOnce();
  });
});
