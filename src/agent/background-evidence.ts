import { createHash } from 'node:crypto';
import { getDb } from '../db/sqlite.js';
import { env } from '../env.js';
import { getMemorySource } from '../memory/source-store.js';
import type { MemorySource } from '../memory/source-store.js';
import { resolveConversationScope } from '../shared/privacy-scope.js';
import { findConversationRef, findMessageRef, findUserRef, isPlatformInternalId } from '../platform/identity-store.js';
import { conversationKey } from '../platform/identity.js';
import { isOneBotMessageRecalled } from '../platform/onebot-notices.js';

export interface PublicationEvidence {
  kind: 'memory_source'; sourceId: string; version: number; hash: string;
  chatId: number; platform: 'telegram' | 'qq'; accountId: string; threadId: number;
  /** UTC milliseconds: no later than either the source event or body version. */
  changedAt: number;
  /** Bounded excerpt; the hash covers the complete authoritative body. */
  text: string;
}
export class PublicationEvidenceError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'PublicationEvidenceError'; }
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const deny = (code: string): never => { throw new PublicationEvidenceError(code); };
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const validThread = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && !isPlatformInternalId(value);
const hashPattern = /^[a-f0-9]{64}$/;

function fromSource(source: MemorySource, chatId: number, threadId: number): PublicationEvidence {
  const scope = resolveConversationScope(chatId);
  if (!scope?.accountId || !validThread(threadId) || source.chat_id !== chatId
    || source.platform !== scope.platform || source.account_id !== scope.accountId
    || (source.thread_id ?? 0) !== threadId || source.tombstone !== 0 || !positive(source.message_id)
    || !positive(source.version) || !positive(source.event_order_ms) || !positive(source.updated_at)
    || source.source_id !== digest(JSON.stringify([scope.platform, scope.accountId, chatId, source.message_id]))
    || source.legacy_id !== `${chatId}_${source.message_id}`) return deny('publication_source_scope_invalid');
  if (!source.event_id || !hashPattern.test(source.event_id)
    || !source.input_revision || !/^(?:original|edit-[a-f0-9]{64})$/.test(source.input_revision)
    || !getDb().prepare('SELECT 1 FROM memory_source_events WHERE event_id=? AND source_id=? AND version=?')
      .get(source.event_id, source.source_id, source.version)) return deny('publication_source_provenance_missing');
  if (getDb().prepare('SELECT 1 FROM memory_retractions WHERE legacy_id=?').get(source.legacy_id)
    || isOneBotMessageRecalled(chatId, source.message_id)) return deny('publication_source_retracted');
  if (typeof source.body_json !== 'string' || typeof source.text_body !== 'string'
    || source.body_json.length > 1024 * 1024 || source.text_body.length > 256 * 1024 || !source.text_body.trim()) {
    return deny('publication_source_body_invalid');
  }
  const body = JSON.parse(source.body_json) as Record<string, unknown> | null;
  if (!body || body['role'] !== 'user' || !positive(body['uid']) || body['messageId'] !== source.message_id
    || body['textContent'] !== source.text_body || body['isBot'] === true) return deny('publication_source_not_user');
  if (scope.platform === 'qq') {
    const chat = findConversationRef(chatId), message = findMessageRef(chatId, source.message_id), user = findUserRef(body['uid']);
    if (scope.accountId !== env().ONEBOT_ACCOUNT_ID || !chat || !message || !user
      || conversationKey(message.conversation) !== conversationKey(chat)
      || user.platform !== 'qq' || user.accountId !== scope.accountId || user.idNamespace !== 'qq-number'
      || user.id === scope.accountId || Number(message.conversation.threadId ?? 0) !== threadId) {
      return deny('publication_source_identity_invalid');
    }
  } else if (isPlatformInternalId(source.message_id) || isPlatformInternalId(body['uid']) || String(body['uid']) === scope.accountId) {
    return deny('publication_source_identity_invalid');
  }
  // A same-body edit must not produce a different publication identity merely
  // because it has another event ID. Timing is checked separately on re-read.
  const hash = digest(JSON.stringify([source.body_json, source.text_body, source.visibility]));
  let text = source.text_body.slice(0, 2000);
  // Avoid returning half of a surrogate pair at the excerpt boundary.
  const last = text.charCodeAt(text.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) text = text.slice(0, -1);
  return { kind: 'memory_source', sourceId: source.source_id, version: source.version, hash,
    chatId, platform: scope.platform, accountId: scope.accountId, threadId,
    // Old backfill retains the old event time; a same-body edit retains the
    // old body-version time. Neither manufactures a newly changed fact.
    changedAt: Math.min(source.event_order_ms, source.updated_at), text };
}

/** Exact bound conversation only. Owner-linked memory grants do not apply to a
 * background publication. The caller registers the returned proof privately. */
export function readPublicationEvidence(chatId: number, threadId: number,
  request: { kind: 'message'; messageId: number }): PublicationEvidence {
  try {
    const scope = resolveConversationScope(chatId);
    if (!scope?.accountId || !validThread(threadId) || request?.kind !== 'message' || !positive(request.messageId)) {
      return deny('publication_source_request_invalid');
    }
    const source = getMemorySource(digest(JSON.stringify([scope.platform, scope.accountId, chatId, request.messageId])));
    if (!source) return deny('publication_source_unavailable');
    return fromSource(source, chatId, threadId);
  } catch (error) {
    if (error instanceof PublicationEvidenceError) throw error;
    return deny('publication_source_unavailable');
  }
}

/** Re-read before proposal acceptance and every actual send. A model-supplied
 * hash/version is never sufficient evidence, even when it looks well formed. */
export function validatePublicationEvidence(proof: unknown): boolean {
  try {
    if (!proof || typeof proof !== 'object') return false;
    const candidate = proof as Partial<PublicationEvidence>;
    if (candidate.kind !== 'memory_source' || typeof candidate.sourceId !== 'string' || !hashPattern.test(candidate.sourceId)
      || !positive(candidate.version) || typeof candidate.hash !== 'string' || !hashPattern.test(candidate.hash)
      || typeof candidate.chatId !== 'number' || !Number.isSafeInteger(candidate.chatId) || candidate.chatId === 0
      || !validThread(candidate.threadId)) return false;
    const source = getMemorySource(candidate.sourceId);
    if (!source) return false;
    const actual = fromSource(source, candidate.chatId, candidate.threadId);
    return actual.version === candidate.version && actual.hash === candidate.hash
      && actual.platform === candidate.platform && actual.accountId === candidate.accountId
      && actual.changedAt === candidate.changedAt && actual.text === candidate.text;
  } catch { return false; }
}
