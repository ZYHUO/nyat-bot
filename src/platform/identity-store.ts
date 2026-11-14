import type Database from 'better-sqlite3';
import { getDb } from '../db/sqlite.js';
import { conversationKey, messageKey, toTelegramTarget, userKey } from './identity.js';
import type { ConversationRef, MessageRef, UserRef } from './types.js';
import { PlatformBoundaryError } from './types.js';

/** Reserve the entire non-Telegram range, including the unallocated boundary. */
export const PLATFORM_INTERNAL_ID_BASE = 2 ** 52;
const MAX_ORDINAL = Number.MAX_SAFE_INTEGER - PLATFORM_INTERNAL_ID_BASE;
type AllocationKind = 'principal' | 'group' | 'message';
type RefKind = 'conversation' | 'user' | 'message';
interface RefRow {
  identity_id: number;
  ref_key: string;
  ref_json: string;
  conversation_identity_id: number | null;
  identity_kind: AllocationKind;
}

/** Unsafe large integers are reserved too: they must never fall through to Telegram. */
export function isPlatformInternalId(value: number | string): boolean {
  if (typeof value === 'number') return Number.isInteger(value) && Math.abs(value) >= PLATFORM_INTERNAL_ID_BASE;
  if (!/^-?\d+$/.test(value)) return false;
  const integer = BigInt(value);
  return (integer < 0n ? -integer : integer) >= BigInt(PLATFORM_INTERNAL_ID_BASE);
}

function ordinalOf(id: number): number | null {
  if (!Number.isSafeInteger(id) || Math.abs(id) <= PLATFORM_INTERNAL_ID_BASE) return null;
  return Math.abs(id) - PLATFORM_INTERNAL_ID_BASE;
}

function telegramNumber(id: string, field: string, positive: boolean): number {
  const numeric = Number(id);
  if (!Number.isSafeInteger(numeric) || numeric === 0 || (positive && numeric < 0)
    || String(numeric) !== id || Math.abs(numeric) >= PLATFORM_INTERNAL_ID_BASE) {
    throw new PlatformBoundaryError('invalid_telegram_id', `${field} must preserve a native Telegram integer below 2^52`);
  }
  return numeric;
}

function telegramConversationId(ref: ConversationRef): number {
  const target = toTelegramTarget(ref);
  telegramNumber(ref.id, 'conversation.id', false);
  if (ref.threadId !== undefined) telegramNumber(ref.threadId, 'threadId', true);
  return target.chatId;
}

function canonicalUser(ref: UserRef): UserRef {
  userKey(ref);
  return { platform: ref.platform, accountId: ref.accountId, idNamespace: ref.idNamespace, id: ref.id };
}

function canonicalConversation(ref: ConversationRef): ConversationRef {
  conversationKey(ref);
  if (ref.platform === 'qq' && ref.conversationKind === 'private' && ref.threadId !== undefined) {
    throw new PlatformBoundaryError('unsupported_private_thread', 'QQ private-chat threads cannot share an unambiguous principal route');
  }
  return {
    platform: ref.platform, accountId: ref.accountId, idNamespace: ref.idNamespace,
    conversationKind: ref.conversationKind, id: ref.id,
    ...(ref.threadId !== undefined ? { threadId: ref.threadId } : {}),
  };
}

function canonicalMessage(ref: MessageRef): MessageRef {
  messageKey(ref);
  return { conversation: canonicalConversation(ref.conversation), id: ref.id };
}

function corruption(): never {
  throw new PlatformBoundaryError('corrupt_platform_identity', 'Stored platform identity is inconsistent; refusing to route');
}

/** All allocations and aliases commit together under SQLite's immediate write lock. */
export class PlatformIdentityStore {
  private readonly db: Database.Database;

  constructor(db: Database.Database) { this.db = db; }

  private allocate(kind: AllocationKind, key: string): number {
    const existing = this.db.prepare('SELECT id FROM platform_identity_allocations WHERE identity_kind = ? AND identity_key = ?')
      .get(kind, key) as { id: number } | undefined;
    if (existing) {
      if (!Number.isSafeInteger(existing.id) || existing.id < 1 || existing.id > MAX_ORDINAL) corruption();
      return existing.id;
    }
    const sequence = this.db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'platform_identity_allocations'")
      .get() as { seq: number } | undefined;
    if (sequence && (!Number.isSafeInteger(sequence.seq) || sequence.seq >= MAX_ORDINAL)) {
      throw new PlatformBoundaryError('platform_id_space_exhausted', 'Platform numeric identity space is exhausted');
    }
    const result = this.db.prepare('INSERT INTO platform_identity_allocations (identity_kind, identity_key) VALUES (?, ?)')
      .run(kind, key);
    const id = Number(result.lastInsertRowid);
    if (!Number.isSafeInteger(id) || id < 1 || id > MAX_ORDINAL) corruption();
    return id;
  }

  private alias(kind: RefKind, key: string, id: number, ref: ConversationRef | UserRef | MessageRef, conversationId: number | null = null): void {
    const json = JSON.stringify(ref);
    this.db.prepare(`INSERT INTO platform_identity_refs (ref_kind, ref_key, identity_id, ref_json, conversation_identity_id)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(ref_kind, ref_key) DO NOTHING`).run(kind, key, id, json, conversationId);
    const row = this.row(kind, id);
    if (!row || row.ref_key !== key || row.ref_json !== json || row.conversation_identity_id !== conversationId) corruption();
  }

  private principal(ref: UserRef): number {
    const id = this.allocate('principal', userKey(ref));
    const conversation: ConversationRef = { ...ref, conversationKind: 'private' };
    this.alias('user', userKey(ref), id, ref);
    this.alias('conversation', conversationKey(conversation), id, canonicalConversation(conversation));
    return id;
  }

  private conversation(ref: ConversationRef): number {
    if (ref.conversationKind === 'private') return this.principal(canonicalUser(ref));
    const id = this.allocate('group', conversationKey(ref));
    this.alias('conversation', conversationKey(ref), id, ref);
    return id;
  }

  private row(kind: RefKind, id: number): RefRow | undefined {
    return this.db.prepare(`SELECT r.identity_id, r.ref_key, r.ref_json, r.conversation_identity_id, a.identity_kind
      FROM platform_identity_refs r JOIN platform_identity_allocations a ON a.id = r.identity_id
      WHERE r.ref_kind = ? AND r.identity_id = ?`).get(kind, id) as RefRow | undefined;
  }

  getOrCreateConversationId(input: ConversationRef): number {
    const ref = canonicalConversation(input);
    if (ref.platform === 'telegram') return telegramConversationId(ref);
    const ordinal = this.db.transaction(() => this.conversation(ref)).immediate();
    return (ref.conversationKind === 'group' ? -1 : 1) * (PLATFORM_INTERNAL_ID_BASE + ordinal);
  }

  getOrCreateUserId(input: UserRef): number {
    const ref = canonicalUser(input);
    if (ref.platform === 'telegram') return telegramNumber(ref.id, 'user.id', true);
    return PLATFORM_INTERNAL_ID_BASE + this.db.transaction(() => this.principal(ref)).immediate();
  }

  getOrCreateMessageId(input: MessageRef): number {
    const ref = canonicalMessage(input);
    if (ref.conversation.platform === 'telegram') {
      telegramConversationId(ref.conversation);
      return telegramNumber(ref.id, 'message.id', true);
    }
    return PLATFORM_INTERNAL_ID_BASE + this.db.transaction(() => {
      const conversationId = this.conversation(ref.conversation);
      const id = this.allocate('message', messageKey(ref));
      this.alias('message', messageKey(ref), id, ref, conversationId);
      return id;
    }).immediate();
  }

  findConversationRef(chatId: number): ConversationRef | null {
    const ordinal = ordinalOf(chatId);
    if (ordinal === null) return null;
    const row = this.row('conversation', ordinal);
    if (!row) return null;
    try {
      const ref = canonicalConversation(JSON.parse(row.ref_json) as ConversationRef);
      if (ref.platform !== 'qq' || conversationKey(ref) !== row.ref_key
        || row.identity_kind !== (ref.conversationKind === 'group' ? 'group' : 'principal')) corruption();
      return (chatId < 0) === (ref.conversationKind === 'group') ? ref : null;
    } catch { return corruption(); }
  }

  findUserRef(uid: number): UserRef | null {
    const ordinal = ordinalOf(uid);
    if (ordinal === null || uid < 0) return null;
    const row = this.row('user', ordinal);
    if (!row) return null;
    try {
      const ref = canonicalUser(JSON.parse(row.ref_json) as UserRef);
      if (ref.platform !== 'qq' || row.identity_kind !== 'principal' || userKey(ref) !== row.ref_key) corruption();
      return ref;
    } catch { return corruption(); }
  }

  findMessageRef(chatId: number, messageId: number): MessageRef | null {
    const ordinal = ordinalOf(messageId);
    const conversationOrdinal = ordinalOf(chatId);
    if (ordinal === null || messageId < 0 || conversationOrdinal === null) return null;
    const conversation = this.findConversationRef(chatId);
    if (!conversation) return null;
    const row = this.row('message', ordinal);
    if (!row || row.conversation_identity_id !== conversationOrdinal) return null;
    try {
      const ref = canonicalMessage(JSON.parse(row.ref_json) as MessageRef);
      if (row.identity_kind !== 'message' || ref.conversation.platform !== 'qq'
        || messageKey(ref) !== row.ref_key || conversationKey(ref.conversation) !== conversationKey(conversation)) corruption();
      return ref;
    } catch { return corruption(); }
  }
}

const stores = new WeakMap<Database.Database, PlatformIdentityStore>();
function currentStore(): PlatformIdentityStore {
  const db = getDb();
  let store = stores.get(db);
  if (!store) { store = new PlatformIdentityStore(db); stores.set(db, store); }
  return store;
}

// Native Telegram identities do not allocate, require a database, or create QQ aliases.
export function getOrCreateConversationId(ref: ConversationRef): number {
  if (ref.platform === 'telegram') return telegramConversationId(ref);
  return currentStore().getOrCreateConversationId(ref);
}
export function getOrCreateUserId(ref: UserRef): number {
  if (ref.platform === 'telegram') { userKey(ref); return telegramNumber(ref.id, 'user.id', true); }
  return currentStore().getOrCreateUserId(ref);
}
export function getOrCreateMessageId(ref: MessageRef): number {
  if (ref.conversation.platform === 'telegram') {
    messageKey(ref); telegramConversationId(ref.conversation);
    return telegramNumber(ref.id, 'message.id', true);
  }
  return currentStore().getOrCreateMessageId(ref);
}
export function findConversationRef(chatId: number): ConversationRef | null {
  return ordinalOf(chatId) === null ? null : currentStore().findConversationRef(chatId);
}
export function findUserRef(uid: number): UserRef | null {
  return ordinalOf(uid) === null || uid < 0 ? null : currentStore().findUserRef(uid);
}
export function findMessageRef(chatId: number, messageId: number): MessageRef | null {
  return ordinalOf(chatId) === null || ordinalOf(messageId) === null || messageId < 0
    ? null : currentStore().findMessageRef(chatId, messageId);
}
