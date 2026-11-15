import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationRef, UserRef } from '../../../src/platform/types.js';
import { fromTelegramChatId, qqOfficialConversation } from '../../../src/platform/identity.js';

const mocks = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: mocks.getDb }));
import {
  PlatformIdentityStore, PLATFORM_INTERNAL_ID_BASE, isPlatformInternalId,
  getOrCreateConversationId, getOrCreateUserId, getOrCreateMessageId,
  findConversationRef, findUserRef, findMessageRef,
} from '../../../src/platform/identity-store.js';

const migration = readFileSync('migrations/0118_platform_identity.sql', 'utf8');
const base = PLATFORM_INTERNAL_ID_BASE;
const group: ConversationRef = {
  platform: 'qq', accountId: '80001', idNamespace: 'qq-number', conversationKind: 'group', id: '70001',
};
const user: UserRef = { platform: 'qq', accountId: '80001', idNamespace: 'qq-number', id: '70001' };
const dm: ConversationRef = { ...user, conversationKind: 'private' };
let db: Database.Database;
let store: PlatformIdentityStore;
const opened: Database.Database[] = [];
function memoryDb(): Database.Database {
  const connection = new Database(':memory:');
  connection.pragma('foreign_keys = ON');
  connection.exec(migration);
  opened.push(connection);
  return connection;
}
function allocations(connection = db): number {
  return (connection.prepare('SELECT COUNT(*) AS n FROM platform_identity_allocations').get() as { n: number }).n;
}
beforeEach(() => {
  db = memoryDb();
  store = new PlatformIdentityStore(db);
  mocks.getDb.mockReset().mockReturnValue(db);
});
afterEach(() => { for (const connection of opened.splice(0)) if (connection.open) connection.close(); });

describe('durable platform identities', () => {
  it('loads the real migration idempotently and allocates above the reserved boundary', () => {
    db.exec(migration);
    expect(store.getOrCreateConversationId(group)).toBe(-(base + 1));
    expect(allocations()).toBe(1);
    expect(db.pragma('quick_check')).toEqual([{ quick_check: 'ok' }]);
  });

  it('shares a QQ private-chat identity with its user in either creation order', () => {
    const uid = store.getOrCreateUserId(user);
    expect(store.getOrCreateConversationId(dm)).toBe(uid);
    expect(store.findConversationRef(uid)).toEqual(dm);
    expect(store.findUserRef(uid)).toEqual(user);
    const otherDm = { ...dm, id: '70002' };
    const chatId = store.getOrCreateConversationId(otherDm);
    expect(store.getOrCreateUserId({ ...user, id: '70002' })).toBe(chatId);
    expect(store.findUserRef(chatId)).toEqual({ ...user, id: '70002' });
    expect(allocations()).toBe(2);
    const groupId = store.getOrCreateConversationId(group);
    expect(groupId).toBeLessThan(-base);
    expect(Math.abs(groupId)).not.toBe(uid);
  });

  it('isolates QQ accounts, namespaces, group/private kinds and opaque ID punctuation', () => {
    const refs = [group, dm, { ...group, accountId: '80002' },
      qqOfficialConversation('80001', 'group', '70001'),
      qqOfficialConversation('a:b', 'group', 'c'), qqOfficialConversation('a', 'group', 'b:c'),
      qqOfficialConversation('80001', 'group', '0070001'),
    ];
    const ids = refs.map(ref => store.getOrCreateConversationId(ref));
    expect(new Set(ids.map(Math.abs)).size).toBe(refs.length);
    refs.forEach((ref, index) => expect(store.findConversationRef(ids[index]!)).toEqual(ref));
    expect(store.getOrCreateUserId({ ...user, accountId: '80002' })).not.toBe(store.getOrCreateUserId(user));
    expect(store.getOrCreateUserId({ ...user, idNamespace: 'qq-openid' })).not.toBe(store.getOrCreateUserId(user));
  });

  it('passes native Telegram IDs through without allocating or requiring a database', () => {
    const telegram = fromTelegramChatId('telegram-bot', -10012345, 12);
    mocks.getDb.mockImplementation(() => { throw new Error('native Telegram must not open the identity database'); });
    expect(getOrCreateConversationId(telegram)).toBe(-10012345);
    expect(getOrCreateUserId({ platform: 'telegram', idNamespace: 'telegram', accountId: 'telegram-bot', id: '70001' })).toBe(70001);
    expect(getOrCreateMessageId({ conversation: telegram, id: '123' })).toBe(123);
    expect(findConversationRef(-10012345)).toBeNull();
    expect(findUserRef(70001)).toBeNull();
    expect(findMessageRef(-10012345, 123)).toBeNull();
    expect(mocks.getDb).not.toHaveBeenCalled();
    expect(allocations()).toBe(0);
    expect(store.getOrCreateConversationId(group)).not.toBe(-70001);
    expect(store.getOrCreateUserId(user)).not.toBe(70001);
  });

  it('rejects Telegram IDs/topics from the internal range and noncanonical numeric text', () => {
    const telegram = fromTelegramChatId('bot', 123);
    for (const id of [String(base), String(base + 1), '9007199254740992', '00123', '1e3', '0']) {
      expect(() => getOrCreateConversationId({ ...telegram, id })).toThrow();
      expect(() => getOrCreateUserId({ ...telegram, id })).toThrow();
      expect(() => getOrCreateMessageId({ conversation: telegram, id })).toThrow();
    }
    expect(() => getOrCreateConversationId({ ...telegram, id: String(-base), conversationKind: 'group' })).toThrow();
    expect(() => getOrCreateConversationId({ ...telegram, threadId: String(base) })).toThrow();
    expect(allocations()).toBe(0);
  });

  it('reserves numeric-string routes and unknown/unsafe high values without routing them to Telegram', () => {
    for (const value of [base, -base, base + 1, -base - 1, Number.MAX_SAFE_INTEGER, base * 4,
      String(base), String(-base), '9007199254740992123456']) expect(isPlatformInternalId(value)).toBe(true);
    for (const value of [0, 123, -123, base - 1, 1.5, NaN, Infinity, '@channel', '1e16', '']) {
      expect(isPlatformInternalId(value)).toBe(false);
    }
    expect(store.findConversationRef(base)).toBeNull();
    expect(store.findConversationRef(base + 999)).toBeNull();
    expect(store.findConversationRef(Number.MAX_SAFE_INTEGER + 1)).toBeNull();
    expect(store.findConversationRef(NaN)).toBeNull();
  });

  it('isolates message IDs by their complete conversation and preserves opaque/negative platform message IDs', () => {
    const other = { ...group, id: '70002' };
    const firstChat = store.getOrCreateConversationId(group);
    const secondChat = store.getOrCreateConversationId(other);
    const first = { conversation: group, id: '-123' };
    const second = { conversation: other, id: '-123' };
    const firstId = store.getOrCreateMessageId(first);
    const secondId = store.getOrCreateMessageId(second);
    expect(firstId).toBeGreaterThan(base);
    expect(secondId).not.toBe(firstId);
    expect(store.getOrCreateMessageId(first)).toBe(firstId);
    expect(store.findMessageRef(firstChat, firstId)).toEqual(first);
    expect(store.findMessageRef(secondChat, secondId)).toEqual(second);
    expect(store.findMessageRef(secondChat, firstId)).toBeNull();
    expect(store.findMessageRef(-firstChat, firstId)).toBeNull();
    expect(store.findMessageRef(firstChat, -firstId)).toBeNull();
    expect(store.findMessageRef(firstChat, 123)).toBeNull();
  });

  it('preserves explicit QQ group sub-conversations but refuses ambiguous private threads', () => {
    const a = { ...group, threadId: 'topic/a' };
    const b = { ...group, threadId: 'topic/b' };
    const first = store.getOrCreateConversationId(a);
    const second = store.getOrCreateConversationId(b);
    expect(first).not.toBe(second);
    expect(store.findConversationRef(first)).toEqual(a);
    expect(store.getOrCreateMessageId({ conversation: a, id: '1' }))
      .not.toBe(store.getOrCreateMessageId({ conversation: b, id: '1' }));
    const before = allocations();
    expect(() => store.getOrCreateConversationId({ ...dm, threadId: 'topic' })).toThrow('private-chat threads');
    expect(allocations()).toBe(before);
  });

  it('retains exact identities and reverse routes after reopening a serialized SQLite database', () => {
    const chatId = store.getOrCreateConversationId(group);
    const uid = store.getOrCreateUserId(user);
    const message = { conversation: group, id: 'message/opaque' };
    const mid = store.getOrCreateMessageId(message);
    const serialized = db.serialize();
    db.close();
    const reopened = new Database(serialized);
    opened.push(reopened);
    reopened.pragma('foreign_keys = ON');
    reopened.exec(migration);
    const nextProcess = new PlatformIdentityStore(reopened);
    expect(nextProcess.getOrCreateConversationId(group)).toBe(chatId);
    expect(nextProcess.getOrCreateConversationId(dm)).toBe(uid);
    expect(nextProcess.getOrCreateUserId(user)).toBe(uid);
    expect(nextProcess.getOrCreateMessageId(message)).toBe(mid);
    expect(nextProcess.findConversationRef(chatId)).toEqual(group);
    expect(nextProcess.findUserRef(uid)).toEqual(user);
    expect(nextProcess.findMessageRef(chatId, mid)).toEqual(message);
    expect(allocations(reopened)).toBe(3);
  });

  it('rolls back allocation, principal aliases and message linkage together on a write failure', () => {
    db.exec(`CREATE TRIGGER synthetic_message_failure BEFORE INSERT ON platform_identity_refs
      WHEN NEW.ref_kind = 'message' BEGIN SELECT RAISE(ABORT, 'synthetic message failure'); END`);
    expect(() => store.getOrCreateMessageId({ conversation: dm, id: '1' })).toThrow('synthetic message failure');
    expect(allocations()).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM platform_identity_refs').get()).toEqual({ n: 0 });
    db.exec('DROP TRIGGER synthetic_message_failure');
    expect(store.getOrCreateMessageId({ conversation: dm, id: '1' })).toBe(base + 2);
    expect(store.getOrCreateUserId(user)).toBe(base + 1);
  });

  it('shares durable allocation across independently constructed stores', () => {
    const otherStore = new PlatformIdentityStore(db);
    const first = store.getOrCreateUserId(user);
    for (let i = 0; i < 20; i++) {
      expect(otherStore.getOrCreateConversationId(dm)).toBe(first);
      expect(store.getOrCreateUserId(user)).toBe(first);
    }
    expect(allocations()).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM platform_identity_refs').get()).toEqual({ n: 2 });
  });

  it('serializes competing SQLite writer transactions and resolves a retry to the committed identity', () => {
    // Only this lock-contention test needs a shared file; all ordinary fixtures
    // use :memory:. The unique temporary directory never points at project data.
    const directory = mkdtempSync(join(tmpdir(), 'nyat-platform-identity-test-'));
    const file = join(directory, 'identity.db');
    const firstDb = new Database(file);
    const secondDb = new Database(file);
    try {
      firstDb.exec(migration);
      firstDb.pragma('foreign_keys = ON');
      secondDb.pragma('foreign_keys = ON');
      secondDb.pragma('busy_timeout = 0');
      const firstStore = new PlatformIdentityStore(firstDb);
      const secondStore = new PlatformIdentityStore(secondDb);
      let first = 0;
      firstDb.transaction(() => {
        first = firstStore.getOrCreateUserId(user);
        expect(() => secondStore.getOrCreateConversationId(dm)).toThrow(/locked|busy/i);
        expect(allocations(secondDb)).toBe(0);
      }).immediate();
      expect(secondStore.getOrCreateConversationId(dm)).toBe(first);
      expect(secondStore.findUserRef(first)).toEqual(user);
      expect(allocations(firstDb)).toBe(1);
    } finally {
      secondDb.close(); firstDb.close();
      for (const suffix of ['', '-journal', '-wal', '-shm']) if (existsSync(file + suffix)) unlinkSync(file + suffix);
      rmdirSync(directory);
    }
  });

  it('does not reuse a committed identity number even after explicitly deleting its mapping', () => {
    const first = store.getOrCreateConversationId(group);
    db.prepare('DELETE FROM platform_identity_refs WHERE identity_id = ?').run(Math.abs(first) - base);
    db.prepare('DELETE FROM platform_identity_allocations WHERE id = ?').run(Math.abs(first) - base);
    const next = store.getOrCreateConversationId(group);
    expect(Math.abs(next)).toBeGreaterThan(Math.abs(first));
    expect(store.findConversationRef(first)).toBeNull();
  });

  it('allocates the last safe integer exactly and fails closed when the reserved space is exhausted', () => {
    store.getOrCreateConversationId(group);
    db.prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = 'platform_identity_allocations'")
      .run(Number.MAX_SAFE_INTEGER - base - 1);
    expect(store.getOrCreateUserId(user)).toBe(Number.MAX_SAFE_INTEGER);
    expect(store.findUserRef(Number.MAX_SAFE_INTEGER)).toEqual(user);
    const before = allocations();
    expect(() => store.getOrCreateUserId({ ...user, id: 'next' })).toThrow('space is exhausted');
    expect(allocations()).toBe(before);
  });

  it('fails closed for corrupt reverse mappings and does not confuse group/user/message spaces', () => {
    const chatId = store.getOrCreateConversationId(group);
    const uid = store.getOrCreateUserId(user);
    const mid = store.getOrCreateMessageId({ conversation: group, id: '1' });
    expect(store.findConversationRef(-chatId)).toBeNull();
    expect(store.findConversationRef(-uid)).toBeNull();
    expect(store.findUserRef(chatId)).toBeNull();
    expect(store.findUserRef(mid)).toBeNull();
    expect(store.findMessageRef(chatId, uid)).toBeNull();
    db.prepare("UPDATE platform_identity_refs SET ref_json = ? WHERE ref_kind = 'conversation' AND identity_id = ?")
      .run(JSON.stringify({ ...group, id: 'different' }), Math.abs(chatId) - base);
    expect(() => store.findConversationRef(chatId)).toThrow('Stored platform identity is inconsistent');
  });

  it('uses the shared runtime store for QQ and refuses invalid namespaces without allocating', () => {
    const uid = getOrCreateUserId(user);
    expect(getOrCreateConversationId(dm)).toBe(uid);
    expect(findConversationRef(uid)).toEqual(dm);
    expect(findUserRef(uid)).toEqual(user);
    const mid = getOrCreateMessageId({ conversation: dm, id: 'opaque' });
    expect(findMessageRef(uid, mid)).toEqual({ conversation: dm, id: 'opaque' });
    const before = allocations();
    expect(() => getOrCreateConversationId({ ...group, idNamespace: 'telegram' })).toThrow();
    expect(() => getOrCreateUserId({ ...user, id: '' })).toThrow();
    expect(allocations()).toBe(before);
  });
});
