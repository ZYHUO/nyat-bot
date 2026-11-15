import { getDb } from '../../db/sqlite.js';
import { env } from '../../env.js';
import { matchesContextScope, resolveContextScope } from '../../context-engine/scope.js';
import type { ContextScope } from '../../context-engine/scope.js';
import { findConversationRef, findMessageRef, PLATFORM_INTERNAL_ID_BASE } from '../../platform/identity-store.js';
import type { FormattedMessage } from '../../shared/types.js';
import { getNyatDb } from '../../nyatdb/index.js';

const PREFIX = 'context-storage:v1:';

/** Canonical complete scope; no arithmetic, truncation or lossy ID hashes. */
export function contextStorageKey(scope: ContextScope): string {
  return JSON.stringify([scope.platform, scope.accountId, scope.chatId, scope.conversationKind, scope.threadId]);
}
export function contextRedisKey(scope: ContextScope): string {
  return 'xxb:ctx:v2:' + contextStorageKey(scope);
}

/** Metadata discovery only. A key never establishes provenance for its payload. */
export function parseContextRedisKey(key: string): ContextScope | null {
  if (!key.startsWith('xxb:ctx:v2:') || key.length > 1024) return null;
  try {
    const fields: unknown = JSON.parse(key.slice('xxb:ctx:v2:'.length));
    if (!Array.isArray(fields) || fields.length !== 5) return null;
    const [platform, accountId, chatId, kind, threadId] = fields;
    if ((platform !== 'telegram' && platform !== 'qq') || typeof accountId !== 'string' || !accountId
      || typeof chatId !== 'number' || !Number.isSafeInteger(chatId) || chatId === 0
      || (kind !== 'private' && kind !== 'group') || typeof threadId !== 'number'
      || !Number.isSafeInteger(threadId) || threadId < 0) return null;
    const scope = resolveStorageScope(chatId, threadId);
    return scope && contextRedisKey(scope) === key ? scope : null;
  } catch {
    // Corrupt aliases / unavailable identity store cannot turn a key into a current account.
    return null;
  }
}

/** Unknown accounts and inactive QQ accounts never borrow another account's context. */
export function resolveStorageScope(chatId: number, threadId?: number): ContextScope | null {
  const scope = resolveContextScope(chatId, threadId);
  if (!scope || (scope.platform === 'qq' && scope.accountId !== env().ONEBOT_ACCOUNT_ID)) return null;
  return scope;
}

/** Shared ordinal prevents collision with all existing/future QQ DM/chat aliases. */
export function contextStorageId(scope: ContextScope, create = false): number | null {
  const db = getDb(), key = contextStorageKey(scope), reserved = PREFIX + key;
  const read = (): number | null => {
    const row = db.prepare(`SELECT s.*, a.identity_kind, a.identity_key,
      EXISTS(SELECT 1 FROM platform_identity_refs r WHERE r.identity_id = s.allocation_id) AS has_alias FROM context_storage_scopes s
      JOIN platform_identity_allocations a ON a.id = s.allocation_id WHERE s.scope_key = ?`).get(key) as {
      allocation_id: number; platform: string; account_id: string; chat_id: number;
      conversation_kind: string; thread_id: number; identity_kind: string; identity_key: string; has_alias: number;
    } | undefined;
    if (!row) return null;
    const id = PLATFORM_INTERNAL_ID_BASE + row.allocation_id;
    const candidate = row.identity_key.slice((reserved + ':candidate:').length);
    if (!Number.isSafeInteger(id) || row.allocation_id < 1 || row.has_alias !== 0 || row.identity_kind !== 'message'
      || !row.identity_key.startsWith(reserved + ':candidate:') || !/^(?:[1-9]|[12]\d|3[0-2])$/.test(candidate)
      || row.platform !== scope.platform || row.account_id !== scope.accountId || row.chat_id !== scope.chatId
      || row.conversation_kind !== scope.conversationKind || row.thread_id !== scope.threadId) throw Error('context_storage_scope_corrupt');
    return id;
  };
  const existing = read();
  if (existing !== null || !create) return existing;
  return db.transaction(() => {
    const current = read();
    if (current !== null) return current;
    const ndb = getNyatDb();
    if (!ndb) throw Error('context_storage_probe_unavailable');
    for (let attempt = 1; attempt <= 32; attempt++) {
      const candidateKey = reserved + ':candidate:' + attempt;
      db.prepare("INSERT INTO platform_identity_allocations (identity_kind, identity_key) VALUES ('message', ?) ON CONFLICT DO NOTHING").run(candidateKey);
      const allocation = db.prepare("SELECT id FROM platform_identity_allocations WHERE identity_kind = 'message' AND identity_key = ?")
        .get(candidateKey) as { id: number };
      const candidateId = PLATFORM_INTERNAL_ID_BASE + allocation.id;
      if (!Number.isSafeInteger(candidateId)) throw Error('context_storage_id_exhausted');
      // The old engine accepted arbitrary numeric keys. Preserve any occupied
      // legacy bucket even if it has no routing alias or verifiable provenance.
      if (ndb.chatRecent(candidateId, 1).length > 0) continue;
      db.prepare(`INSERT INTO context_storage_scopes (scope_key, allocation_id, platform, account_id, chat_id, conversation_kind, thread_id)
        VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(scope_key) DO NOTHING`)
        .run(key, allocation.id, scope.platform, scope.accountId, scope.chatId, scope.conversationKind, scope.threadId);
      return read();
    }
    throw Error('context_storage_candidates_occupied');
  }).immediate();
}

function normalizedThread(value: unknown): number | null {
  if (value === undefined) return 0;
  const numeric = typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value) ? Number(value) : value;
  return typeof numeric === 'number' && Number.isSafeInteger(numeric) && numeric >= 0 ? numeric > 1 ? numeric : 0 : null;
}

/** Verify identity before accepting source-aware old rows; never stamp an old account. */
function matchesEventIdentity(message: FormattedMessage, scope: ContextScope): boolean {
  const ref = message.eventIdentity?.ref;
  if (!ref || ref.conversation.platform !== scope.platform || ref.conversation.accountId !== scope.accountId
    || ref.conversation.conversationKind !== scope.conversationKind || normalizedThread(ref.conversation.threadId) !== scope.threadId) return false;
  if (scope.platform === 'telegram') return ref.conversation.idNamespace === 'telegram'
    && ref.conversation.id === String(scope.chatId) && ref.id === String(message.messageId);
  const conversation = findConversationRef(scope.chatId), mapped = findMessageRef(scope.chatId, message.messageId);
  return !!conversation && !!mapped && ref.conversation.idNamespace === conversation.idNamespace
    && ref.conversation.id === conversation.id && ref.id === mapped.id;
}

/** Read guard for NyatDB, Redis, merge and summarization. Malformed provenance is not legacy. */
export function isMessageInContextScope(message: FormattedMessage, scope: ContextScope): boolean {
  if (!message || !Number.isSafeInteger(message.messageId) || message.messageId <= 0
    || (message.messageThreadId !== undefined && normalizedThread(message.messageThreadId) !== scope.threadId)) return false;
  if (message.contextScope !== undefined && !matchesContextScope(message.contextScope, scope)) return false;
  if (message.eventIdentity !== undefined && !matchesEventIdentity(message, scope)) return false;
  return message.contextScope !== undefined || message.eventIdentity !== undefined;
}

/** Only live gateway identities or already-bound rows can acquire a storage binding. */
export function bindContextMessage(chatId: number, message: FormattedMessage, threadId?: number): { scope: ContextScope; message: FormattedMessage } {
  const sourceThread = threadId ?? message.messageThreadId ?? message.eventIdentity?.ref.conversation.threadId;
  const normalized = normalizedThread(sourceThread);
  const scope = normalized === null ? null : resolveStorageScope(chatId, normalized);
  if (!scope || (message.messageThreadId !== undefined && normalizedThread(message.messageThreadId) !== scope.threadId)
    || (message.contextScope !== undefined && !matchesContextScope(message.contextScope, scope))
    || (message.eventIdentity !== undefined && !matchesEventIdentity(message, scope))
    || (message.role !== 'assistant' && !message.contextScope && !message.eventIdentity)) throw Error('context_source_unproven');
  return { scope, message: { ...message, contextScope: scope, ...(scope.threadId ? { messageThreadId: scope.threadId } : {}) } };
}
