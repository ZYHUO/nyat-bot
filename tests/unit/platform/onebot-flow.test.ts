import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FormattedMessage } from '../../../src/shared/types.js';
import type { AttentionItem } from '../../../src/meta/types.js';
import type { NormalizedMessage } from '../../../src/platform/types.js';

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(), getRedis: vi.fn(), enqueue: vi.fn(), event: vi.fn(),
  addMessage: vi.fn(), getRecent: vi.fn(), recordUser: vi.fn(), loop: vi.fn(),
  config: {
    ONEBOT_ENABLED: true, ONEBOT_ACCOUNT_ID: '42', ONEBOT_OWNER_ID: '99', ONEBOT_DISPLAY_NAME: '啾咪囝',
    ONEBOT_ALLOWED_GROUP_IDS: '', ONEBOT_ALLOWED_USER_IDS: '', MASTER_UID: 99,
    META_SUBAGENT_ENABLED: true, META_SUBAGENT_CHAT_IDS: [] as number[], META_ACTIVATED_AT_SEC: 1,
    CODEACT_ISOLATION_ENABLED: true, META_L0_COALESCE_MS: 0, META_ATTENTION_TOP_N: 20,
    META_DEFER_ENABLED: false, HEART_ENABLED: false, META_HEART_ENABLED: false,
    META_HEART_BYPASS_CHAT_IDS: [] as number[], TIMING_GATE_ENABLED: false,
    BOT_USERNAME: 'telegram_fixture_bot', BOT_NICKNAMES: ['fixture-nyat'], RATE_LIMIT_PER_MIN: 100,
    NYATOS_SHADOW_ENABLED: false, TRENCH_DEBT_ATTENTION_ENABLED: false,
  },
}));
vi.mock('../../../src/env.js', () => ({ env: () => mocks.config }));
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: mocks.getDb }));
vi.mock('../../../src/db/redis.js', () => ({ getRedis: mocks.getRedis }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: {
  debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
} }));
vi.mock('../../../src/queue/producer.js', () => ({ enqueue: mocks.enqueue }));
vi.mock('../../../src/agent/cognitive-events.js', () => ({ appendTelegramMessageEvent: mocks.event }));
vi.mock('../../../src/pipeline/context/manager.js', () => ({ addMessage: mocks.addMessage, getRecent: mocks.getRecent }));
vi.mock('../../../src/memory/chroma.js', () => ({ memorizeMessage: vi.fn() }));
vi.mock('../../../src/tracking/activity.js', () => ({ recordMessage: vi.fn() }));
vi.mock('../../../src/tracking/user-profile.js', () => ({ recordUserMessage: mocks.recordUser }));
vi.mock('../../../src/tracking/reply-activity.js', () => ({ recordHumanMessage: vi.fn() }));
vi.mock('../../../src/tracking/sleep.js', () => ({ isAsleep: async () => false }));
vi.mock('../../../src/metrics/social-ledger.js', () => ({ recordMessageSeen: vi.fn() }));
vi.mock('../../../src/metrics/registry.js', () => ({ incrCounter: vi.fn() }));
vi.mock('../../../src/subagent/post-task-window.js', () => ({ ingestIncomingPostTask: vi.fn() }));
vi.mock('../../../src/meta/speaker-burst.js', () => ({ markSpeakerBurst: vi.fn(), shouldForceSameSpeakerL0: async () => false }));
vi.mock('../../../src/meta/loop.js', () => ({ metaTick: mocks.loop }));
vi.mock('../../../src/meta/timing-adapter.js', () => ({ evaluateMetaTiming: async () => ({ verdict: 'allow', reason: 'fixture_no_llm' }) }));
// Feature commands, sleep and external bookkeeping are separate concerns. Keep
// formatter/direct detector/classifier/Meta flags/Attention and both ingress
// functions real; an unrecognized @bot becomes L2 and cannot pass this fixture.
vi.mock('../../../src/meta/ingress-intercepts.js', () => ({
  metaNeedsLegacyPipeline: () => false, metaMuteBlocksReply: () => false,
  tryMetaIngressIntercepts: async () => 'continue',
}));
vi.mock('../../../src/meta/bookkeeping.js', () => ({
  runMetaBookkeepingHooks: vi.fn(), metaSleepGate: async () => 'awake', messageHasMedia: () => false,
}));
vi.mock('../../../src/meta/index.js', async () => {
  const attention = await import('../../../src/meta/attention.js');
  const flags = await import('../../../src/meta/flags.js');
  return { getAttentionAccumulator: attention.getAttentionAccumulator, isMetaSubagentChat: flags.isMetaSubagentChat };
});
vi.mock('../../../src/pipeline/turn/actor.js', () => ({ isTurnActorChat: () => false }));
vi.mock('../../../src/pipeline/turn/buffer.js', () => ({ appendPending: vi.fn() }));
vi.mock('../../../src/pipeline/turn/abort-registry.js', () => ({ interruptGeneration: vi.fn() }));
vi.mock('../../../src/pipeline/turn/focus.js', () => ({ bumpFocus: vi.fn() }));
vi.mock('../../../src/queue/turn-scheduler.js', () => ({ scheduleTurn: vi.fn() }));
vi.mock('../../../src/pipeline/turn/obligation-store.js', () => ({
  saveObligation: vi.fn(), setActiveObligation: vi.fn(), supersedeActiveObligation: vi.fn(),
  getActiveObligationId: vi.fn(), getObligation: vi.fn(), updateObligationState: vi.fn(),
}));

import { createOneBotCodec } from '../../../src/platform/onebot.js';
import { oneBotToCoreUpdate, ingestOneBotMessage } from '../../../src/platform/onebot-ingress.js';
import { isOneBotOwner } from '../../../src/platform/owner-context.js';
import { getOrCreateConversationId, getOrCreateUserId, getOrCreateMessageId, PLATFORM_INTERNAL_ID_BASE } from '../../../src/platform/identity-store.js';
import { fromTelegramChatId, qqOfficialConversation, qqOfficialUser } from '../../../src/platform/identity.js';
import { ingestChatUpdate } from '../../../src/bot/handlers/message.js';
import { getBotIdentity } from '../../../src/bot/bot.js';
import { detectDirectInteraction } from '../../../src/pipeline/timing/direct-interaction.js';
import { formatMessage } from '../../../src/pipeline/formatter.js';
import { _resetAttentionAccumulator } from '../../../src/meta/attention.js';

// Behavioral Redis fixture: SET NX/expiry, rate counters and Attention lists
// actually retain state. Assertions observe persisted Attention, not call counts.
class FixtureRedis {
  readonly values = new Map<string, { text: string; expires: number }>();
  readonly lists = new Map<string, string[]>();
  failClaims = false;
  claimHook: (() => void) | undefined;
  private current(key: string): string | null {
    const entry = this.values.get(key);
    if (!entry || entry.expires <= Date.now()) { this.values.delete(key); return null; }
    return entry.text;
  }
  async set(key: string, value: string, ...args: Array<string | number>): Promise<'OK' | null> {
    if (key.startsWith('xxb:onebot:received:')) {
      if (this.failClaims) throw new Error('synthetic redis unavailable');
      this.claimHook?.();
    }
    if (args.includes('NX') && this.current(key) !== null) return null;
    const at = args.indexOf('EX');
    this.values.set(key, { text: value, expires: at < 0 ? Infinity : Date.now() + Number(args[at + 1]) * 1000 });
    return 'OK';
  }
  async get(key: string): Promise<string | null> { return this.current(key); }
  async eval(script: string, _keyCount: number, key: string): Promise<number> {
    if (!script.includes("redis.call('INCR'")) throw new Error('unexpected Redis Lua in ingress fixture');
    const next = Number(this.current(key) ?? 0) + 1;
    this.values.set(key, { text: String(next), expires: Date.now() + 60_000 });
    return next;
  }
  async lrange(key: string, start: number, end: number): Promise<string[]> {
    return (this.lists.get(key) ?? []).slice(start, end < 0 ? undefined : end + 1);
  }
  async llen(key: string): Promise<number> { return (this.lists.get(key) ?? []).length; }
  multi() {
    const operations: Array<() => void> = [];
    const pipeline = {
      lpush: (key: string, text: string) => { operations.push(() => this.lists.set(key, [text, ...(this.lists.get(key) ?? [])])); return pipeline; },
      ltrim: (key: string, start: number, end: number) => { operations.push(() => this.lists.set(key, (this.lists.get(key) ?? []).slice(start, end + 1))); return pipeline; },
      exec: async () => { operations.forEach(operation => operation()); return operations.map(() => [null, 1]); },
    };
    return pipeline;
  }
}

const migration = readFileSync('migrations/0118_platform_identity.sql', 'utf8');
const codec = createOneBotCodec('42');
let db: Database.Database;
let redis: FixtureRedis;
const context = new Map<number, FormattedMessage[]>();
function normalize(kind: 'private' | 'group', id: number, parts: unknown[] = [{ type: 'text', data: { text: '这是一条合成测试消息' } }], overrides: Record<string, unknown> = {}): NormalizedMessage {
  return codec.normalize({ post_type: 'message', self_id: 42, user_id: 99, message_type: kind, group_id: 123,
    message_id: id, time: Math.floor(Date.now() / 1000), sender: { nickname: '测试用户' }, message: parts, ...overrides })!;
}
const signal = () => new AbortController().signal;
function attention(): AttentionItem[] { return (redis.lists.get('xxb:meta:attention') ?? []).map(raw => JSON.parse(raw) as AttentionItem); }
function mention(qq = '42'): unknown[] { return [{ type: 'text', data: { text: '你好😀 ' } }, { type: 'at', data: { qq } }, { type: 'text', data: { text: ' 请回应这条测试消息' } }]; }
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON'); db.exec(migration);
  redis = new FixtureRedis(); context.clear();
  mocks.getDb.mockReturnValue(db); mocks.getRedis.mockReturnValue(redis);
  Object.assign(mocks.config, { ONEBOT_ENABLED: true, ONEBOT_ACCOUNT_ID: '42', ONEBOT_OWNER_ID: '99',
    ONEBOT_ALLOWED_GROUP_IDS: '', ONEBOT_ALLOWED_USER_IDS: '', META_ACTIVATED_AT_SEC: Math.floor(Date.now() / 1000) - 60 });
  mocks.event.mockImplementation(({ platform, messageId }: { platform: string; messageId: number }) => `${platform}:event:${messageId}`);
  mocks.addMessage.mockImplementation(async (chatId: number, message: FormattedMessage) => {
    context.set(chatId, [...(context.get(chatId) ?? []), structuredClone(message)]);
  });
  mocks.getRecent.mockImplementation(async (chatId: number) => context.get(chatId) ?? []);
  _resetAttentionAccumulator();
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); db.close(); });

describe('real OneBot codec to shared Meta ingress', () => {
  it('routes QQ DM through real formatting and shared ingest into durable L0 Attention', async () => {
    const normalized = normalize('private', 1);
    const update = oneBotToCoreUpdate(normalized);
    const message = update.message!;
    expect(message.chat.id).toBeGreaterThan(PLATFORM_INTERNAL_ID_BASE);
    expect(message.chat.id).toBe(message.from!.id);
    expect(formatMessage(update)).toMatchObject({ role: 'user', uid: message.from!.id, messageId: message.message_id });
    await ingestChatUpdate(update);
    expect(attention()).toHaveLength(1);
    expect(attention()[0]).toMatchObject({ chatId: message.chat.id, userId: message.from!.id,
      messageId: message.message_id, layer: 'L0', reason: 'dm', textPreview: '这是一条合成测试消息' });
    expect(context.get(message.chat.id)).toHaveLength(1);
    expect(mocks.event).toHaveBeenCalledWith(expect.objectContaining({ platform: 'qq' }));
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('recognizes actual @bot entities after UTF-16 text and routes group L0 without legacy enqueue', async () => {
    const update = oneBotToCoreUpdate(normalize('group', 2, mention()));
    const message = update.message!;
    const identity = getBotIdentity(message.chat.id);
    expect(message.chat.id).toBeLessThan(-PLATFORM_INTERNAL_ID_BASE);
    expect(identity.uid).toBeGreaterThan(PLATFORM_INTERNAL_ID_BASE);
    expect(identity.displayName).toBe('啾咪囝');
    expect(message.text).toContain('@啾咪囝');
    expect(message.text).not.toContain(`@${identity.uid}`);
    expect(message.entities?.[0]).toMatchObject({ type: 'text_mention', offset: '你好😀 '.length, user: { id: identity.uid } });
    expect(detectDirectInteraction(update, { botUid: identity.uid, botUsername: identity.username, botNicknames: identity.nicknames })).toBe('mention');
    await ingestChatUpdate(update);
    expect(attention()).toHaveLength(1);
    expect(attention()[0]).toMatchObject({ chatId: message.chat.id, layer: 'L0', reason: 'direct:mention' });
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('does not turn another user mention or plain @number text into a direct interaction', async () => {
    for (const [id, parts] of [[3, mention('777')], [4, [{ type: 'text', data: { text: '@42 普通数字文字' } }]]] as const) {
      const update = oneBotToCoreUpdate(normalize('group', id, [...parts]));
      const identity = getBotIdentity(update.message!.chat.id);
      expect(detectDirectInteraction(update, { botUid: identity.uid, botUsername: identity.username, botNicknames: identity.nicknames })).toBeNull();
      await ingestChatUpdate(update);
    }
    expect(attention()).toHaveLength(0); // Heart is off in this fixture; passive messages do not get invented L0.
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('recognizes a quote of a confirmed local bot message, while missing/foreign quotes stay passive', async () => {
    const normalized = normalize('group', 5, [{ type: 'reply', data: { id: '-10' } }, { type: 'text', data: { text: '接着这个回答说' } }]);
    const chatId = getOrCreateConversationId(normalized.ref.conversation);
    const botUid = getBotIdentity(chatId).uid;
    const quotedMid = getOrCreateMessageId({ conversation: normalized.ref.conversation, id: '-10' });
    const recent: FormattedMessage[] = [{ role: 'assistant', uid: botUid, username: '', fullName: '测试机器人',
      timestamp: Math.floor(Date.now() / 1000), messageId: quotedMid, textContent: '此前确认发送的测试回答', isForwarded: false, isBot: true }];
    context.set(chatId, recent);
    const update = oneBotToCoreUpdate(normalized, recent);
    const identity = getBotIdentity(chatId);
    expect(detectDirectInteraction(update, { botUid, botUsername: identity.username, botNicknames: identity.nicknames })).toBe('reply_to_bot');
    await ingestOneBotMessage(normalized, { signal: signal() });
    expect(attention()[0]).toMatchObject({ layer: 'L0', reason: 'direct:reply_to_bot',
      payload: { replyTo: { messageId: quotedMid, uid: botUid, textSnippet: '此前确认发送的测试回答' } } });
    const missing = oneBotToCoreUpdate(normalize('group', 6, [{ type: 'reply', data: { id: '-999' } }]), recent);
    expect(detectDirectInteraction(missing, { botUid, botUsername: '', botNicknames: [] })).toBeNull();
    const foreign = oneBotToCoreUpdate(normalized, [{ ...recent[0]!, uid: getOrCreateUserId({ ...normalized.sender, id: '777' }), role: 'user', isBot: false }]);
    expect(detectDirectInteraction(foreign, { botUid, botUsername: '', botNicknames: [] })).toBeNull();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('keeps repeat mappings stable and same raw Telegram IDs separate through the real shared ingress', async () => {
    const normalized = normalize('private', 1);
    const first = oneBotToCoreUpdate(normalized);
    const second = oneBotToCoreUpdate(normalized);
    expect(second.message!.chat.id).toBe(first.message!.chat.id);
    expect(second.message!.from!.id).toBe(first.message!.from!.id);
    expect(second.message!.message_id).toBe(first.message!.message_id);
    expect(getOrCreateConversationId(fromTelegramChatId('tg', 99))).toBe(99);
    await ingestChatUpdate(first);
    await ingestChatUpdate({ update_id: 1, message: { message_id: 1, date: Math.floor(Date.now() / 1000),
      chat: { id: 99, type: 'private', first_name: 'Telegram user' }, from: { id: 99, first_name: 'Telegram user', is_bot: false }, text: 'same raw ID on Telegram' } });
    expect(new Set(attention().map(item => item.chatId)).size).toBe(2);
    expect(new Set(attention().map(item => item.messageId)).size).toBe(2);
    expect(mocks.event.mock.calls.map(call => call[0].platform)).toEqual(['qq', 'telegram']);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
});

describe('OneBot gateway acceptance and authorization', () => {
  it('claims simultaneous duplicate delivery once using real SET NX behavior', async () => {
    const normalized = normalize('private', 20);
    await Promise.all([ingestOneBotMessage(normalized, { signal: signal() }), ingestOneBotMessage(normalized, { signal: signal() })]);
    expect(attention()).toHaveLength(1);
    expect(mocks.event).toHaveBeenCalledTimes(1);
    expect(mocks.addMessage).toHaveBeenCalledTimes(1);
    const claim = [...redis.values].filter(([key]) => key.startsWith('xxb:onebot:received:'));
    expect(claim).toHaveLength(1);
    expect(claim[0]![1].expires - Date.now()).toBe(86400_000);
  });

  it('does not dispatch or claim messages from disabled, disallowed or foreign accounts', async () => {
    const denied = normalize('private', 21);
    mocks.config.ONEBOT_ENABLED = false;
    await ingestOneBotMessage(denied, { signal: signal() });
    mocks.config.ONEBOT_ENABLED = true; mocks.config.ONEBOT_ALLOWED_USER_IDS = '88';
    await ingestOneBotMessage(denied, { signal: signal() });
    mocks.config.ONEBOT_ALLOWED_USER_IDS = ''; mocks.config.ONEBOT_ALLOWED_GROUP_IDS = '888';
    await ingestOneBotMessage(normalize('group', 22, mention()), { signal: signal() });
    const foreign = createOneBotCodec('43').normalize({ post_type: 'message', self_id: 43, user_id: 99, message_type: 'private', message_id: 23,
      time: Math.floor(Date.now() / 1000), message: [{ type: 'text', data: { text: 'foreign account' } }] })!;
    await ingestOneBotMessage(foreign, { signal: signal() });
    expect(attention()).toHaveLength(0);
    expect(mocks.event).not.toHaveBeenCalled();
    expect(redis.values.size).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM platform_identity_allocations').get()).toEqual({ n: 0 });
  });

  it('accepts explicitly allowed private and group messages', async () => {
    mocks.config.ONEBOT_ALLOWED_USER_IDS = '99'; mocks.config.ONEBOT_ALLOWED_GROUP_IDS = '123';
    await ingestOneBotMessage(normalize('private', 24), { signal: signal() });
    await ingestOneBotMessage(normalize('group', 25, mention()), { signal: signal() });
    expect(attention()).toHaveLength(2);
    expect(attention().every(item => item.layer === 'L0')).toBe(true);
  });

  it('fails closed on Redis claim failure, then accepts a safe subsequent delivery once', async () => {
    const normalized = normalize('private', 26);
    redis.failClaims = true;
    await expect(ingestOneBotMessage(normalized, { signal: signal() })).rejects.toThrow('synthetic redis unavailable');
    expect(mocks.event).not.toHaveBeenCalled(); expect(attention()).toHaveLength(0);
    redis.failClaims = false;
    await ingestOneBotMessage(normalized, { signal: signal() });
    expect(attention()).toHaveLength(1);
  });

  it('rejects pre-activation/future imports and already cancelled ingress', async () => {
    const normalized = normalize('private', 27);
    await ingestOneBotMessage({ ...normalized, timestampMs: mocks.config.META_ACTIVATED_AT_SEC * 1000 - 1 }, { signal: signal() });
    await ingestOneBotMessage({ ...normalized, timestampMs: Date.now() + 300001 }, { signal: signal() });
    const cancelled = new AbortController(); cancelled.abort();
    await ingestOneBotMessage(normalized, { signal: cancelled.signal });
    expect(mocks.event).not.toHaveBeenCalled(); expect(redis.values.size).toBe(0);
  });

  it('does not ingest if its connection is cancelled while the Redis claim is in flight', async () => {
    const cancelled = new AbortController();
    redis.claimHook = () => cancelled.abort();
    await ingestOneBotMessage(normalize('private', 28), { signal: cancelled.signal });
    expect(mocks.event).not.toHaveBeenCalled(); expect(attention()).toHaveLength(0);
  });

  it('keeps QQ owner authority separate from Telegram, other QQ accounts and OpenIDs', () => {
    const owner = normalize('private', 29);
    const chatId = getOrCreateConversationId(owner.ref.conversation);
    const uid = getOrCreateUserId(owner.sender);
    expect(isOneBotOwner(chatId, uid)).toBe(true);
    expect(isOneBotOwner(99, 99)).toBe(false); // MASTER_UID is deliberately the same raw number.
    expect(isOneBotOwner(chatId, getOrCreateUserId({ ...owner.sender, id: '88' }))).toBe(false);
    const otherAccount = { ...owner.ref.conversation, accountId: '43' };
    expect(isOneBotOwner(getOrCreateConversationId(otherAccount), getOrCreateUserId({ ...owner.sender, accountId: '43' }))).toBe(false);
    expect(isOneBotOwner(chatId, getOrCreateUserId({ ...owner.sender, accountId: '43' }))).toBe(false);
    expect(isOneBotOwner(getOrCreateConversationId(qqOfficialConversation('42', 'private', '99')),
      getOrCreateUserId(qqOfficialUser('42', '99')))).toBe(false);
  });

  it('refuses mismatched DM principals and cross-account mentions/quotes before entering cognition', () => {
    const normalized = normalize('private', 30);
    expect(() => oneBotToCoreUpdate({ ...normalized, sender: { ...normalized.sender, id: '88' } })).toThrow();
    expect(() => oneBotToCoreUpdate({ ...normalized, segments: [{ type: 'mention', user: { ...normalized.sender, accountId: '43' } }] })).toThrow();
    expect(() => oneBotToCoreUpdate({ ...normalized, segments: [{ type: 'reply', message: {
      conversation: { ...normalized.ref.conversation, id: '88' }, id: '1',
    } }] })).toThrow();
    expect(mocks.event).not.toHaveBeenCalled();
  });
});
