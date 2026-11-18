import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NyatDb } from '../../../../packages/nyatdb/src/engine.js';
import { unpackChatLogRow, chatAppendFromFormatted, packChatLogBody } from '../../../../packages/nyatdb/src/chat-log.js';
import type { FormattedMessage } from '../../../../src/shared/types.js';

const lists = new Map<string, string[]>();
const hashes = new Map<string, Map<string, string>>();
const sets = new Map<string, Set<string>>();
const zsets = new Map<string, Map<string, number>>();

const redisMock = {
  eval: vi.fn(async (_script: string, _n: number, key: string, payload: string) => {
    const l = lists.get(key) ?? [];
    l.push(payload);
    lists.set(key, l);
    return l.length;
  }),
  lrange: vi.fn(async (key: string, start: number, end: number) => {
    const l = lists.get(key) ?? [];
    const a = start < 0 ? Math.max(0, l.length + start) : start;
    const b = end < 0 ? l.length + end : end;
    return l.slice(a, b + 1);
  }),
  lindex: vi.fn(async (key: string, idx: number) => {
    const l = lists.get(key) ?? [];
    const i = idx < 0 ? l.length + idx : idx;
    return l[i] ?? null;
  }),
  zadd: vi.fn(async (key: string, score: number, member: string) => {
    const z = zsets.get(key) ?? new Map();
    z.set(member, score);
    zsets.set(key, z);
    return 1;
  }),
  hset: vi.fn(async (key: string, field: string, value: string) => {
    const h = hashes.get(key) ?? new Map();
    h.set(field, value);
    hashes.set(key, h);
    return 1;
  }),
  expire: vi.fn(async () => 1),
  sadd: vi.fn(async (key: string, member: string) => {
    const s = sets.get(key) ?? new Set();
    s.add(member);
    sets.set(key, s);
    return 1;
  }),
  hgetall: vi.fn(async () => ({})),
  smembers: vi.fn(async () => []),
};

const envValues: Record<string, unknown> = {
  BOT_TOKEN: '123:synthetic',
  ONEBOT_ACCOUNT_ID: '42',
  NYATDB_ENABLED: true,
  NYATDB_DUAL_WRITE: true,
  NYATDB_READ: true,
  NYATDB_REDIS_MIRROR: false,
  NYATDB_MAX_MESSAGES_PER_CHAT: 5000,
  CONTEXT_MAX_LENGTH: 400,
};

let db: NyatDb | null = null;
let scopeDb: Database.Database;
let dir = '';

vi.mock('../../../../src/db/redis.js', () => ({ getRedis: () => redisMock }));
vi.mock('../../../../src/db/sqlite.js', () => ({ getDb: () => scopeDb }));
vi.mock('../../../../src/pipeline/context/mid-term.js', () => ({ maybeCompressMidTerm: vi.fn() }));
vi.mock('../../../../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../../src/env.js', () => ({ env: () => envValues }));
vi.mock('../../../../src/nyatdb/index.js', async () => {
  const real = await vi.importActual<typeof import('../../../../src/nyatdb/index.js')>(
    '../../../../src/nyatdb/index.js',
  );
  return {
    ...real,
    getNyatDb: () => db,
    unpackChatLogRow: real.unpackChatLogRow ?? unpackChatLogRow,
  };
});

import { addMessage, getRecent, _resetNyatCatchUpStateForTests } from '../../../../src/pipeline/context/manager.js';
import { contextRedisKey, contextStorageId, resolveStorageScope } from '../../../../src/pipeline/context/storage-scope.js';
import { createMessageEventIdentity } from '../../../../src/shared/event-identity.js';
import { formatMessage } from '../../../../src/pipeline/formatter.js';
import { telegramHeartPhysicalBodyHash, telegramHeartWaitContext } from '../../../../src/meta/heart-source-fingerprint.js';
import { fromTelegramChatId } from '../../../../src/platform/identity.js';
import { findConversationRef, findMessageRef, getOrCreateConversationId, getOrCreateMessageId, getOrCreateUserId, PLATFORM_INTERNAL_ID_BASE } from '../../../../src/platform/identity-store.js';

const CHAT = -424242;

function msg(id: number, text: string, role: 'user' | 'assistant' = 'user', chatId = CHAT, threadId = 0) {
  return {
    role,
    uid: role === 'assistant' ? 0 : 7,
    username: 'u',
    fullName: 'User',
    timestamp: 1_780_000_000 + id,
    messageId: id,
    textContent: text,
    isForwarded: false,
    ...(threadId ? { messageThreadId: threadId } : {}),
    contextScope: resolveStorageScope(chatId, threadId)!,
    eventIdentity: createMessageEventIdentity({ ref: { conversation: fromTelegramChatId(String(envValues.BOT_TOKEN).split(':')[0]!, chatId, threadId || undefined), id: String(id) }, occurredAt: 1_780_000_000_000 }),
  };
}

describe('context manager NyatDB-primary', () => {
  beforeEach(() => {
    lists.clear();
    hashes.clear();
    sets.clear();
    zsets.clear();
    vi.clearAllMocks();
    _resetNyatCatchUpStateForTests();
    envValues.NYATDB_ENABLED = true;
    envValues.NYATDB_DUAL_WRITE = true;
    envValues.NYATDB_READ = true;
    envValues.NYATDB_REDIS_MIRROR = false;
    envValues.NYATDB_MAX_MESSAGES_PER_CHAT = 5000;
    envValues.BOT_TOKEN = '123:synthetic';
    dir = mkdtempSync(join(tmpdir(), 'ctx-nyat-'));
    scopeDb = new Database(join(dir, 'scopes.sqlite'));
    scopeDb.pragma('foreign_keys = ON');
    for (const name of ['0118_platform_identity.sql', '0120_onebot_notices.sql', '0132_context_storage_scopes.sql']) {
      scopeDb.exec(readFileSync('migrations/' + name, 'utf8'));
    }
    db = NyatDb.open({ path: dir, syncEvery: 1, chatRingMax: 100 });
  });

  afterEach(() => {
    db?.close();
    db = null;
    scopeDb.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('writes NyatDB and skips Redis ctx when mirror off', async () => {
    await addMessage(CHAT, msg(1, '小鱼干'));
    await addMessage(CHAT, msg(2, '收到', 'assistant'));

    expect(redisMock.eval).not.toHaveBeenCalled();
    const recent = await getRecent(CHAT, 10);
    expect(recent.map((m) => m.textContent)).toEqual(['小鱼干', '收到']);
    expect(recent[1]!.role).toBe('assistant');
  });

  it('verifies the exact sender, quote and gateway revision after a NyatDB-only restart', async () => {
    const topic = 7;
    const original = msg(22, 'Which gate?', 'user', CHAT, topic);
    const gateway = {
      message_id: original.messageId, message_thread_id: topic, date: original.timestamp,
      chat: { id: CHAT, type: 'supergroup' }, from: { id: 22, first_name: 'Bo', is_bot: false },
      text: original.textContent,
      reply_to_message: { message_id: 10, from: { id: 33, first_name: 'Kai' }, text: 'Doors open at six' },
    };
    const source = formatMessage({ message: gateway, __nyatEventIdentity: original.eventIdentity })!;
    source.pendingIntent = { laneKey: 'synthetic-lane', intentId: 'synthetic-intent', revision: 1,
      platform: 'telegram', chatId: CHAT, accountId: '123', threadId: topic, senderId: source.uid };
    await addMessage(CHAT, source);
    const storageId = contextStorageId(resolveStorageScope(CHAT, topic)!)!;
    const body = db!.chatRecent(storageId, 1)[0]!.text;
    expect(body).not.toContain('synthetic-lane');
    expect(body).not.toContain(String(envValues.BOT_TOKEN));
    db!.close();
    db = NyatDb.open({ path: dir, syncEvery: 1, chatRingMax: 100 });
    _resetNyatCatchUpStateForTests();
    const first = await telegramHeartWaitContext(CHAT, topic);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ isBot: false, uid: 22, messageId: 22,
      replyTo: { messageId: 10, uid: 33, textSnippet: 'Doors open at six' }, eventIdentity: source.eventIdentity });
    expect(first[0]!.pendingIntent).toBeUndefined();
    expect(telegramHeartPhysicalBodyHash(first[0]!)).toBe(telegramHeartPhysicalBodyHash(source));

    // Identical visible text, author and physical ID still cannot bless the old revision.
    const editedIdentity = createMessageEventIdentity({ ref: original.eventIdentity.ref, edit: true,
      occurredAt: original.eventIdentity.occurredAt, editedAt: (original.timestamp + 1) * 1000, updateId: 881, content: gateway.text });
    const edited = formatMessage({ edited_message: { ...gateway, edit_date: original.timestamp + 1 },
      __nyatEventIdentity: editedIdentity })!;
    await addMessage(CHAT, edited);
    const latest = await telegramHeartWaitContext(CHAT, topic);
    expect(latest).toHaveLength(1);
    expect(latest[0]!.eventIdentity).toEqual(editedIdentity);
    expect(telegramHeartPhysicalBodyHash(latest[0]!)).not.toBe(telegramHeartPhysicalBodyHash(source));
    expect(telegramHeartPhysicalBodyHash(latest[0]!)).toBe(telegramHeartPhysicalBodyHash(edited));
    expect(redisMock.eval).not.toHaveBeenCalled();
  });

  it('keeps legacy scoped bodies readable without inferring the missing revision', async () => {
    const source = msg(9, 'Which entrance?', 'user', CHAT, 2);
    const legacyPayload = { ...source, eventIdentity: undefined };
    const old = { messageId: source.messageId, uid: source.uid, role: source.role,
      ts: source.timestamp, bodyFormat: 'json' as const, text: JSON.stringify(legacyPayload) };
    const storageId = contextStorageId(resolveStorageScope(CHAT, 2)!, true)!;
    db!.chatAppend(storageId, old);
    const latest = await telegramHeartWaitContext(CHAT, 2);
    expect(latest).toHaveLength(1);
    expect(latest[0]!.textContent).toBe(source.textContent);
    expect(latest[0]!.eventIdentity).toBeUndefined();
    expect(telegramHeartPhysicalBodyHash(latest[0]!)).not.toBe(telegramHeartPhysicalBodyHash(source));
    expect(db!.chatRecent(storageId, 1)[0]!.text).toBe(old.text);
  });

  it('keeps the existing body budget when evidence does not fit and declines lossy quotes', async () => {
    const source = msg(11, 'x'.repeat(2180), 'user', CHAT, 2);
    const legacyPayload = { ...source, eventIdentity: undefined };
    expect(packChatLogBody(source)).toBe(packChatLogBody(legacyPayload));
    await addMessage(CHAT, source);
    const quoted = { ...msg(12, 'Same question?', 'user', CHAT, 2),
      replyTo: { uid: 8, messageId: 5, fullName: 'B', textSnippet: 'x'.repeat(200) } };
    await addMessage(CHAT, quoted);
    const latest = await telegramHeartWaitContext(CHAT, 2);
    expect(latest).toHaveLength(2);
    expect(latest[0]!.textContent).toBe(source.textContent);
    expect(latest[0]!.eventIdentity).toBeUndefined();
    expect(telegramHeartPhysicalBodyHash(latest[0]!)).not.toBe(telegramHeartPhysicalBodyHash(source));
    expect(latest[1]!.replyTo?.textSnippet).not.toBe(quoted.replyTo.textSnippet);
    expect(telegramHeartPhysicalBodyHash(latest[1]!)).not.toBe(telegramHeartPhysicalBodyHash(quoted));
  });

  it('skips Redis LRANGE on getRecent after a clean merge', async () => {
    await addMessage(CHAT, msg(1, 'a'));
    await addMessage(CHAT, msg(2, 'b'));
    redisMock.lrange.mockClear();
    redisMock.lindex.mockClear();
    await getRecent(CHAT, 10); // first: peek Redis, settle skip
    const peeks = redisMock.lrange.mock.calls.length;
    expect(peeks).toBeGreaterThan(0);
    redisMock.lrange.mockClear();
    const again = await getRecent(CHAT, 10);
    expect(again.map((m) => m.textContent)).toEqual(['a', 'b']);
    expect(redisMock.lrange).not.toHaveBeenCalled();
  });

  it('mirrors to Redis when NYATDB_REDIS_MIRROR=true', async () => {
    envValues.NYATDB_REDIS_MIRROR = true;
    await addMessage(CHAT, msg(3, '镜像'));
    expect(redisMock.eval).toHaveBeenCalledOnce();
    const key = contextRedisKey(resolveStorageScope(CHAT)!);
    expect(lists.get(key)?.length).toBe(1);
  });

  it('falls back to Redis and backfills empty NyatDB', async () => {
    const key = contextRedisKey(resolveStorageScope(CHAT)!);
    lists.set(key, [JSON.stringify(msg(10, '来自redis'))]);

    const recent = await getRecent(CHAT, 10);
    expect(recent.map((m) => m.textContent)).toEqual(['来自redis']);

    // After backfill, NyatDB serves the row; Redis is still peeked for hole-merge.
    lists.set(key, []);
    const again = await getRecent(CHAT, 10);
    expect(again.map((m) => m.textContent)).toEqual(['来自redis']);
  });

  it('catches up NyatDB when Redis tip is ahead', async () => {
    // Seed NyatDB tip=1 without marking catchUpSettled via addMessage
    db!.chatAppend(contextStorageId(resolveStorageScope(CHAT)!, true)!, {
      messageId: 1,
      ts: 1_780_000_001,
      uid: 7,
      role: 'user',
      text: JSON.stringify({
        role: 'user',
        uid: 7,
        username: 'u',
        fullName: 'User',
        timestamp: 1_780_000_001,
        messageId: 1,
        textContent: 'old',
        isForwarded: false,
        contextScope: resolveStorageScope(CHAT)!,
      }),
      bodyFormat: 'json',
    });
    const key = contextRedisKey(resolveStorageScope(CHAT)!);
    lists.set(key, [
      JSON.stringify(msg(1, 'old')),
      JSON.stringify(msg(2, 'gap-a')),
      JSON.stringify(msg(3, 'gap-b')),
    ]);
    redisMock.lindex = vi.fn(async (k: string, idx: number) => {
      const l = lists.get(k) ?? [];
      const i = idx < 0 ? l.length + idx : idx;
      return l[i] ?? null;
    });

    const recent = await getRecent(CHAT, 10);
    expect(recent.map((m) => m.textContent)).toEqual(['old', 'gap-a', 'gap-b']);
    expect(recent.at(-1)!.messageId).toBe(3);
  });

  it('merges Redis hole messages into NyatDB recent', async () => {
    db!.chatAppend(contextStorageId(resolveStorageScope(CHAT)!, true)!, {
      messageId: 10,
      ts: 1_780_000_010,
      uid: 7,
      role: 'user',
      text: JSON.stringify({ ...msg(10, 'early'), role: 'user' }),
      bodyFormat: 'json',
    });
    db!.chatAppend(contextStorageId(resolveStorageScope(CHAT)!, true)!, {
      messageId: 30,
      ts: 1_780_000_030,
      uid: 7,
      role: 'user',
      text: JSON.stringify({ ...msg(30, 'late'), role: 'user' }),
      bodyFormat: 'json',
    });
    // Redis has the missing middle (incl. prior bot line) — dual-write hole
    lists.set(contextRedisKey(resolveStorageScope(CHAT)!), [
      JSON.stringify(msg(10, 'early')),
      JSON.stringify(msg(20, '哼，谁信你呀', 'assistant')),
      JSON.stringify(msg(30, 'late')),
    ]);

    const recent = await getRecent(CHAT, 10);
    expect(recent.map((m) => m.messageId)).toEqual([10, 20, 30]);
    expect(recent[1]!.textContent).toContain('谁信你');
  });

  it('falls back to Redis write when NyatDB unavailable', async () => {
    db = null;
    await addMessage(CHAT, msg(20, 'redis兜底'));
    expect(redisMock.eval).toHaveBeenCalledOnce();
  });

  it('keeps large Telegram topics with identical message IDs separate across restart', async () => {
    const group = -1001234567890;
    expect(group * 100000 + 2).toBe(group * 100000 + 3); // the former collision
    await addMessage(group, msg(42, 'topic-two-canary', 'user', group, 2));
    await addMessage(group, msg(42, 'topic-three-canary', 'user', group, 3));
    const two = contextStorageId(resolveStorageScope(group, 2)!)!;
    const three = contextStorageId(resolveStorageScope(group, 3)!)!;
    expect(Number.isSafeInteger(two)).toBe(true); expect(two).not.toBe(three);
    expect((await getRecent(group, 20, 2)).map(m => m.textContent)).toEqual(['topic-two-canary']);
    expect((await getRecent(group, 20, 3)).map(m => m.textContent)).toEqual(['topic-three-canary']);
    db!.close(); scopeDb.close();
    scopeDb = new Database(join(dir, 'scopes.sqlite'));
    db = NyatDb.open({ path: dir, syncEvery: 1, chatRingMax: 100 });
    _resetNyatCatchUpStateForTests();
    expect(contextStorageId(resolveStorageScope(group, 2)!)).toBe(two);
    expect((await getRecent(group, 20, 2)).map(m => m.textContent)).toEqual(['topic-two-canary']);
    expect((await getRecent(group, 20, 3)).map(m => m.textContent)).toEqual(['topic-three-canary']);
  });

  it('does not reuse former-account context or settled caches after a token switch', async () => {
    await addMessage(CHAT, msg(8, 'account-123-only'));
    const oldKey = contextStorageId(resolveStorageScope(CHAT)!)!;
    await getRecent(CHAT, 20);
    envValues.BOT_TOKEN = '456:synthetic';
    expect(await getRecent(CHAT, 20)).toEqual([]);
    await addMessage(CHAT, msg(8, 'account-456-only'));
    expect(contextStorageId(resolveStorageScope(CHAT)!)).not.toBe(oldKey);
    expect((await getRecent(CHAT, 20)).map(m => m.textContent)).toEqual(['account-456-only']);
    envValues.BOT_TOKEN = '123:synthetic';
    expect((await getRecent(CHAT, 20)).map(m => m.textContent)).toEqual(['account-123-only']);
  });

  it('rechecks current account after awaiting Redis instead of returning a revoked account body', async () => {
    envValues.NYATDB_ENABLED = false;
    const old = msg(12, 'old-account-late-canary');
    lists.set(contextRedisKey(resolveStorageScope(CHAT)!), [JSON.stringify(old)]);
    redisMock.lrange.mockImplementationOnce(async () => {
      envValues.BOT_TOKEN = '456:synthetic';
      return [JSON.stringify(old)];
    });
    expect(await getRecent(CHAT, 20)).toEqual([]);
  });

  it('isolates QQ and Telegram and never gives storage reservations a platform routing alias', async () => {
    const conversation = { platform: 'qq', accountId: '42', idNamespace: 'qq-number', conversationKind: 'group', id: '700' } as const;
    const chatId = getOrCreateConversationId(conversation);
    const ref = { conversation, id: '8' };
    const messageId = getOrCreateMessageId(ref);
    const uid = getOrCreateUserId({ platform: 'qq', accountId: '42', idNamespace: 'qq-number', id: '77' });
    const message: FormattedMessage = { role: 'user', uid, fullName: 'QQ fixture', username: '', timestamp: 1780000000,
      messageId, textContent: 'qq-only', isForwarded: false, eventIdentity: createMessageEventIdentity({ ref, occurredAt: 1780000000000 }) };
    await addMessage(chatId, message); await addMessage(-700, msg(8, 'telegram-only', 'user', -700));
    const storage = contextStorageId(resolveStorageScope(chatId)!)!;
    expect(storage).not.toBe(Math.abs(chatId)); expect(storage).not.toBe(messageId);
    expect(findConversationRef(storage)).toBeNull(); expect(findMessageRef(chatId, storage)).toBeNull();
    expect((await getRecent(chatId, 10)).map(m => m.textContent)).toEqual(['qq-only']);
    expect((await getRecent(-700, 10)).map(m => m.textContent)).toEqual(['telegram-only']);
    envValues.ONEBOT_ACCOUNT_ID = '43';
    expect(await getRecent(chatId, 10)).toEqual([]);
    envValues.ONEBOT_ACCOUNT_ID = '42';
  });

  it('rejects foreign payloads even when inserted into the correct storage bucket or Redis key', async () => {
    const scope = resolveStorageScope(CHAT, 2)!;
    const wrong = msg(5, 'wrong-topic-canary', 'user', CHAT, 3);
    db!.chatAppend(contextStorageId(scope, true)!, chatAppendFromFormatted(wrong));
    // Even a correct-looking storage label cannot override the original gateway ref.
    db!.chatAppend(contextStorageId(scope)!, chatAppendFromFormatted({ ...wrong, contextScope: scope, messageThreadId: 2 }));
    lists.set(contextRedisKey(scope), [JSON.stringify(wrong)]);
    expect(await getRecent(CHAT, 10, 2)).toEqual([]);
  });

  it('keeps legacy ambiguous topic rows unchanged and never guesses their provenance', async () => {
    const group = -1001234567890, oldKey = group * 100000 + 2;
    db!.chatAppend(oldKey, { messageId: 80, ts: 1780000000, uid: 7, role: 'user', text: 'unscoped-legacy-canary' });
    expect(await getRecent(group, 10, 2)).toEqual([]);
    expect(await getRecent(group, 10, 3)).toEqual([]);
    expect(db!.chatRecent(oldKey, 10).map(m => m.text)).toEqual(['unscoped-legacy-canary']);
  });

  it('skips an occupied legacy numeric candidate so scoped retention never trims its original rows', async () => {
    const occupied = PLATFORM_INTERNAL_ID_BASE + 1;
    for (const messageId of [1, 2, 3]) db!.chatAppend(occupied, { messageId, ts: 1780000000, uid: 7, role: 'user', text: 'legacy-original-' + messageId });
    envValues.NYATDB_MAX_MESSAGES_PER_CHAT = 1;
    await addMessage(CHAT, msg(64, 'new-scoped-only'));
    const storage = contextStorageId(resolveStorageScope(CHAT)!)!;
    expect(storage).not.toBe(occupied);
    expect((await getRecent(CHAT, 10)).map(m => m.textContent)).toEqual(['new-scoped-only']);
    expect(db!.chatRecent(occupied, 10).map(m => m.text)).toEqual(['legacy-original-1', 'legacy-original-2', 'legacy-original-3']);
    expect(findConversationRef(occupied)).toBeNull();
  });

  it('fails closed after bounded occupied candidates without registering or trimming any legacy bucket', () => {
    for (let i = 1; i <= 32; i++) db!.chatAppend(PLATFORM_INTERNAL_ID_BASE + i, { messageId: 1, ts: 1780000000, uid: 7, role: 'user', text: 'occupied-' + i });
    expect(() => contextStorageId(resolveStorageScope(CHAT)!, true)).toThrow('context_storage_candidates_occupied');
    expect(scopeDb.prepare('SELECT count(*) AS n FROM context_storage_scopes').get()).toEqual({ n: 0 });
    expect(db!.chatRecent(PLATFORM_INTERNAL_ID_BASE + 32, 10)[0]!.text).toBe('occupied-32');
  });

  it('retains provable old Redis history but refuses unknown and contradictory provenance', async () => {
    const safe = msg(20, 'proven-old-history');
    const identityOnly = { ...safe, contextScope: undefined };
    const unknown = { ...identityOnly, eventIdentity: undefined };
    const foreign = { ...safe, contextScope: { ...safe.contextScope, accountId: '999' } };
    const legacy = [JSON.stringify(identityOnly), JSON.stringify({ ...unknown, messageId: 21, textContent: 'unknown-canary' }), JSON.stringify({ ...foreign, messageId: 22 })];
    lists.set(`xxb:ctx:${CHAT}`, legacy);
    expect((await getRecent(CHAT, 10)).map(m => m.textContent)).toEqual(['proven-old-history']);
    expect(lists.get(`xxb:ctx:${CHAT}`)).toEqual(legacy);
    lists.set(`xxb:ctx:${CHAT}`, []);
    _resetNyatCatchUpStateForTests();
    expect((await getRecent(CHAT, 10)).map(m => m.textContent)).toEqual(['proven-old-history']);
  });

  it('checks topic catch-up independently after a different topic has settled', async () => {
    await addMessage(CHAT, msg(2, 'topic-two', 'user', CHAT, 2));
    await getRecent(CHAT, 10, 2);
    const three = resolveStorageScope(CHAT, 3)!;
    lists.set(contextRedisKey(three), [JSON.stringify(msg(2, 'topic-three-redis', 'user', CHAT, 3))]);
    expect((await getRecent(CHAT, 10, 3)).map(m => m.textContent)).toEqual(['topic-three-redis']);
    lists.set(contextRedisKey(three), []);
    expect((await getRecent(CHAT, 10, 3)).map(m => m.textContent)).toEqual(['topic-three-redis']);
  });

  it('refuses an unidentified user message or a conflicting explicit topic before writing', async () => {
    const unknown = { ...msg(7, 'unproven'), contextScope: undefined, eventIdentity: undefined };
    await expect(addMessage(CHAT, unknown)).rejects.toThrow('context_source_unproven');
    await expect(addMessage(CHAT, msg(7, 'two', 'user', CHAT, 2), 3)).rejects.toThrow('context_source_unproven');
    expect(redisMock.eval).not.toHaveBeenCalled();
    expect(await getRecent(CHAT, 10)).toEqual([]);
  });

  it('keeps provenance and topic in compressed/minimal ChatLog JSON payloads', () => {
    const message = { ...msg(7, '正文'.repeat(8000), 'user', CHAT, 3), fullName: '名'.repeat(8000),
      imageDescriptions: ['图'.repeat(8000)], inlineKeyboard: [{ text: '键'.repeat(1000) }] };
    const json = packChatLogBody(message);
    expect(Buffer.byteLength(json)).toBeLessThanOrEqual(2800);
    const body = JSON.parse(json);
    expect(body.contextScope).toEqual(message.contextScope); expect(body.messageThreadId).toBe(3);
    const stored = unpackChatLogRow({ ...chatAppendFromFormatted(message), role: 0, roleName: 'user' });
    expect(stored.contextScope).toEqual(message.contextScope); expect(stored.messageThreadId).toBe(3);
  });
});
