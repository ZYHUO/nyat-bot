import { createHash, randomUUID } from 'node:crypto';
import { getDb } from '../db/sqlite.js';
import { env } from '../env.js';
import { resolveConversationScope } from '../shared/privacy-scope.js';
import type { FormattedMessage } from '../shared/types.js';
import type { MemoryVisibility } from './visibility.js';
import { defaultVisibilityForChat } from './visibility.js';
import type { MessageEventIdentity } from '../shared/event-identity.js';
import { findMessageRef, isPlatformInternalId } from '../platform/identity-store.js';
import { messageKey } from '../platform/identity.js';

export interface MemorySource {
  source_id: string; legacy_id: string; platform: 'telegram' | 'qq'; account_id: string;
  chat_id: number; message_id: number; thread_id: number | null;
  body_json: string; text_body: string; visibility: MemoryVisibility; version: number;
  event_id: string | null; input_revision: string | null; event_order_ms: number;
  received_at: number; tombstone: number; updated_at: number;
}
export interface MemoryProjectionJob {
  id: number; source_id: string; version: number; model: string; collection: string;
  projection_id: string; state: string; vector_done: number; attempts: number;
  lease_token: string; lease_until: number;
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const projectionId = (sourceId: string, version: number, model: string, collection: string) =>
  `source:${sourceId}:${version}:${hash(JSON.stringify([model, collection])).slice(0, 16)}`;

function durableTransaction<T>(run: () => T): T {
  const db = getDb();
  if (db.inTransaction) return db.transaction(run)();
  const sync = Number(db.pragma('synchronous', { simple: true }));
  db.pragma('synchronous = FULL');
  try { return db.transaction(run)(); }
  finally { db.pragma(`synchronous = ${sync}`); }
}

function enqueue(source: MemorySource, now: number): void {
  const e = env();
  getDb().prepare(`INSERT OR IGNORE INTO memory_projection_jobs
    (source_id,version,model,collection,projection_id,next_attempt_at,created_at)
    VALUES (?,?,?,?,?,?,?)`).run(source.source_id, source.version, e.MEMORY_EMBED_MODEL,
      e.MEMORY_COLLECTION, projectionId(source.source_id, source.version, e.MEMORY_EMBED_MODEL, e.MEMORY_COLLECTION), now, now);
}

function isLocallyRecalled(chatId: number, messageId: number): boolean {
  if (!isPlatformInternalId(chatId)) return false;
  const db = getDb();
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='onebot_message_recalls'").get()) return false;
  return !!db.prepare('SELECT 1 FROM onebot_message_recalls WHERE chat_id=? AND message_id=?').get(chatId, messageId);
}

/** Synchronous SQLite acceptance, before the first embedding/network await. */
export function persistMemorySource(chatId: number, msg: FormattedMessage, visibilityOverride?: MemoryVisibility): MemorySource | null {
  if (env().MEMORY_PROJECTION_OUTBOX_ENABLED !== true) return null;
  const scope = resolveConversationScope(chatId);
  if (!scope?.accountId || !Number.isSafeInteger(msg.messageId) || msg.messageId <= 0) throw new Error('memory_source_identity_unproven');
  const accountId = scope.accountId;
  const text = msg.textContent || msg.captionContent || '';
  if (!text.trim() || msg.isBot) return null;
  if (isLocallyRecalled(chatId, msg.messageId)) {
    retractMemorySources([`${chatId}_${msg.messageId}`]);
    return null;
  }
  const identity = (msg as FormattedMessage & { eventIdentity?: MessageEventIdentity }).eventIdentity;
  if (!identity) throw new Error('memory_source_event_identity_required');
  {
    const ref = identity.ref;
    if (ref.conversation.platform !== scope.platform || ref.conversation.accountId !== scope.accountId
      || ref.conversation.conversationKind !== scope.conversationKind
      || (scope.platform === 'telegram' ? (ref.conversation.id !== String(chatId) || ref.id !== String(msg.messageId))
        : messageKey(findMessageRef(chatId, msg.messageId) ?? { conversation: ref.conversation, id: 'unmapped' }) !== messageKey(ref))) {
      throw new Error('memory_source_identity_mismatch');
    }
    if (!/^[a-f0-9]{64}$/.test(identity.eventId) || identity.messageKey !== messageKey(ref)) throw new Error('memory_source_event_invalid');
  }
  // Native ingress identity has already validated the opaque QQ identifiers.
  // This local key stays bound to its mapped chat/message and account as well.
  const sourceId = hash(JSON.stringify([scope.platform, scope.accountId, chatId, msg.messageId]));
  const now = Date.now();
  const eventOrder = identity?.editedAt ?? identity?.occurredAt ?? Math.max(0, msg.timestamp * 1000);
  const received = identity?.receivedAt ?? now;
  const body = JSON.stringify({ role: msg.role, uid: msg.uid, username: msg.username, fullName: msg.fullName,
    timestamp: msg.timestamp, messageId: msg.messageId, textContent: text, isForwarded: msg.isForwarded });
  const db = getDb();
  return durableTransaction(() => {
    const current = db.prepare('SELECT * FROM memory_sources WHERE source_id=?').get(sourceId) as MemorySource | undefined;
    if (current?.tombstone || db.prepare('SELECT 1 FROM memory_retractions WHERE legacy_id=?').get(`${chatId}_${msg.messageId}`)) return current ?? null;
    if (identity && db.prepare('SELECT 1 FROM memory_source_events WHERE event_id=?').get(identity.eventId)) {
      if (current) enqueue(current, now);
      return current ?? null;
    }
    // Replayed original/older edits cannot restore a newer body.
    if (current && (eventOrder < current.event_order_ms || (eventOrder === current.event_order_ms && received < current.received_at)
      || (identity?.revision === 'original' && current.input_revision?.startsWith('edit-')))) return current;
    const defaultVisibility = defaultVisibilityForChat(chatId);
    const visibility = defaultVisibility === 'private' ? 'private' : (visibilityOverride ?? defaultVisibility);
    if (current && current.body_json === body && current.visibility === visibility) {
      if (identity) db.prepare('INSERT OR IGNORE INTO memory_source_events(event_id,source_id,version) VALUES (?,?,?)').run(identity.eventId, sourceId, current.version);
      db.prepare('UPDATE memory_sources SET event_order_ms=?,received_at=?,event_id=?,input_revision=? WHERE source_id=?')
        .run(eventOrder, received, identity?.eventId ?? current.event_id, identity?.revision ?? current.input_revision, sourceId);
      enqueue(current, now); return current;
    }
    const source: MemorySource = { source_id: sourceId, legacy_id: `${chatId}_${msg.messageId}`,
      platform: scope.platform, account_id: accountId, chat_id: chatId, message_id: msg.messageId,
      thread_id: identity?.ref.conversation.threadId ? Number(identity.ref.conversation.threadId) : null,
      body_json: body, text_body: text, visibility, version: (current?.version ?? 0) + 1,
      event_id: identity?.eventId ?? null, input_revision: identity?.revision ?? null,
      event_order_ms: eventOrder, received_at: received, tombstone: 0, updated_at: now };
    db.prepare(`INSERT INTO memory_sources
      (source_id,legacy_id,platform,account_id,chat_id,message_id,thread_id,body_json,text_body,visibility,version,event_id,input_revision,event_order_ms,received_at,tombstone,updated_at)
      VALUES (@source_id,@legacy_id,@platform,@account_id,@chat_id,@message_id,@thread_id,@body_json,@text_body,@visibility,@version,@event_id,@input_revision,@event_order_ms,@received_at,@tombstone,@updated_at)
      ON CONFLICT(source_id) DO UPDATE SET body_json=excluded.body_json,text_body=excluded.text_body,visibility=excluded.visibility,
      version=excluded.version,event_id=excluded.event_id,input_revision=excluded.input_revision,event_order_ms=excluded.event_order_ms,
      received_at=excluded.received_at,updated_at=excluded.updated_at`).run(source);
    if (identity) db.prepare('INSERT INTO memory_source_events(event_id,source_id,version) VALUES (?,?,?)').run(identity.eventId, sourceId, source.version);
    db.prepare("UPDATE memory_projection_jobs SET state='superseded',lease_token=NULL,lease_until=NULL WHERE source_id=? AND version<? AND state!='done'").run(sourceId, source.version);
    enqueue(source, now); return source;
  });
}

export function getMemorySource(sourceId: string): MemorySource | null {
  return getDb().prepare('SELECT * FROM memory_sources WHERE source_id=?').get(sourceId) as MemorySource | undefined ?? null;
}

export function hasMemorySourceAuthority(): boolean {
  try { return !!getDb().prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_sources'").get(); }
  catch { return false; }
}

/** Retractions are permanent until an explicit, separately authorized restore exists. */
export function retractMemorySources(ids: string[], now = Date.now()): number {
  const db = getDb();
  return durableTransaction(() => {
    let count = 0;
    for (const id of new Set(ids)) {
      const rows = db.prepare(`SELECT DISTINCT s.* FROM memory_sources s LEFT JOIN memory_projection_jobs j ON j.source_id=s.source_id
        WHERE s.legacy_id=? OR j.projection_id=?`).all(id, id) as MemorySource[];
      if (/^-?\d+_\d+$/.test(id)) db.prepare('INSERT OR IGNORE INTO memory_retractions VALUES (?,?)').run(id, now);
      if (rows.length === 0 && /^-?\d+_\d+$/.test(id)) {
        const [chatId, messageId] = id.split('_').map(Number);
        const scope = resolveConversationScope(chatId!);
        if (scope?.accountId && Number.isSafeInteger(messageId) && messageId! > 0) {
          // A deletion request is not a historical message/provenance backfill.
          const sourceId = hash(JSON.stringify([scope.platform, scope.accountId, chatId, messageId]));
          db.prepare(`INSERT OR IGNORE INTO memory_sources
            (source_id,legacy_id,platform,account_id,chat_id,message_id,body_json,text_body,visibility,version,event_order_ms,received_at,tombstone,updated_at)
            VALUES (?,?,?,?,?,?,'{}','','private',1,0,?,1,?)`).run(sourceId,id,scope.platform,scope.accountId,chatId,messageId,now,now);
          rows.push(getMemorySource(sourceId)!);
        }
      }
      for (const source of rows) {
        db.prepare('INSERT OR IGNORE INTO memory_retractions VALUES (?,?)').run(source.legacy_id, now);
        if (!source.tombstone) {
          db.prepare("UPDATE memory_sources SET tombstone=1,version=version+1,body_json='{}',text_body='',updated_at=? WHERE source_id=?").run(now, source.source_id);
          count++;
        }
        enqueue(getMemorySource(source.source_id)!, now);
      }
    }
    return count;
  });
}

/** Projection text/metadata is never authoritative when it carries a source pointer. */
export function authoritativeMemoryPayload(payload: Record<string, unknown>): Record<string, unknown> | null {
  const hasPointer = payload['sourceId'] !== undefined;
  try {
    const db = getDb();
    if (hasPointer) {
      if (typeof payload['sourceId'] !== 'string' || !Number.isSafeInteger(payload['sourceVersion'])) return null;
      const source = getMemorySource(payload['sourceId']);
      if (!source || source.tombstone || source.version !== payload['sourceVersion'] || isLocallyRecalled(source.chat_id, source.message_id)) return null;
      const projection = db.prepare('SELECT projection_id FROM memory_projection_jobs WHERE source_id=? AND version=? AND model=? AND collection=?')
        .get(source.source_id, source.version, env().MEMORY_EMBED_MODEL, env().MEMORY_COLLECTION) as { projection_id: string } | undefined;
      if (!projection) return null;
      const body = JSON.parse(source.body_json) as Record<string, unknown>;
      return { ...body, mid: source.legacy_id, text: source.text_body, chatId: source.chat_id, sourceChatId: source.chat_id,
        messageId: source.message_id, sourcePlatform: source.platform, sourceAccountId: source.account_id, visibility: source.visibility,
        sourceId: source.source_id, sourceVersion: source.version, projectionId: projection.projection_id };
    }
    // A corrupt vector mid must not bypass a tombstone for the actual message.
    const legacyId = `${String(payload['sourceChatId'] ?? payload['chatId'])}_${String(payload['messageId'])}`;
    if (payload['mid'] !== undefined && payload['mid'] !== legacyId) return null;
    const chatId = payload['sourceChatId'] ?? payload['chatId'];
    if (typeof chatId === 'number' && typeof payload['messageId'] === 'number' && isLocallyRecalled(chatId, payload['messageId'])) return null;
    if (db.prepare('SELECT 1 FROM memory_retractions WHERE legacy_id=?').get(legacyId)) return null;
    // A source-backed edit replaces the legacy payload; do not show the stale body
    // while its new projection is pending, or relabel the old account as current.
    if (db.prepare('SELECT 1 FROM memory_sources WHERE legacy_id=?').get(legacyId)) return null;
    return payload;
  } catch {
    // Existing deployments/tests without this optional migration keep legacy
    // reads. New pointers never fall back, even after disabling the write flag.
    return hasPointer || env().MEMORY_PROJECTION_OUTBOX_ENABLED === true ? null : payload;
  }
}

export function claimMemoryProjection(now = Date.now(), leaseMs = 90_000): MemoryProjectionJob | null {
  const db = getDb(), e = env();
  return db.transaction(() => {
    db.prepare(`UPDATE memory_projection_jobs SET state='failed',last_error='lease_expired_attempt_limit',lease_token=NULL,lease_until=NULL
      WHERE state='running' AND lease_until<=? AND attempts>=8`).run(now);
    db.prepare(`UPDATE memory_projection_jobs SET state='superseded',lease_token=NULL,lease_until=NULL
      WHERE state IN ('pending','running') AND version != (SELECT version FROM memory_sources s WHERE s.source_id=memory_projection_jobs.source_id)`).run();
    const row = db.prepare(`SELECT * FROM memory_projection_jobs WHERE model=? AND collection=? AND
      ((state='pending' AND next_attempt_at<=?) OR (state='running' AND lease_until<=?)) ORDER BY id LIMIT 1`)
      .get(e.MEMORY_EMBED_MODEL, e.MEMORY_COLLECTION, now, now) as MemoryProjectionJob | undefined;
    if (!row) return null;
    const token = randomUUID();
    db.prepare("UPDATE memory_projection_jobs SET state='running',lease_token=?,lease_until=?,attempts=attempts+1 WHERE id=?").run(token, now + leaseMs, row.id);
    return { ...row, state: 'running', lease_token: token, lease_until: now + leaseMs, attempts: row.attempts + 1 };
  })();
}
export function currentProjection(job: MemoryProjectionJob, now = Date.now()): MemorySource | null {
  return getDb().prepare(`SELECT s.* FROM memory_sources s JOIN memory_projection_jobs j ON j.source_id=s.source_id
    WHERE j.id=? AND j.lease_token=? AND j.state='running' AND j.lease_until>? AND s.version=j.version`)
    .get(job.id, job.lease_token, now) as MemorySource | undefined ?? null;
}
export function checkpointMemoryVector(job: MemoryProjectionJob, now = Date.now()): boolean {
  if (!currentProjection(job, now)) return false;
  return getDb().prepare("UPDATE memory_projection_jobs SET vector_done=1 WHERE id=? AND lease_token=? AND state='running'")
    .run(job.id, job.lease_token).changes === 1;
}
export function completeMemoryProjection(job: MemoryProjectionJob, writeLexical: (source: MemorySource) => void, now = Date.now()): boolean {
  return getDb().transaction(() => {
    const source = currentProjection(job, now); if (!source) return false;
    writeLexical(source);
    return getDb().prepare("UPDATE memory_projection_jobs SET state='done',completed_at=?,lease_token=NULL,lease_until=NULL,last_error=NULL WHERE id=? AND lease_token=?")
      .run(now, job.id, job.lease_token).changes === 1;
  })();
}
export function failMemoryProjection(job: MemoryProjectionJob, code: string, now = Date.now()): void {
  getDb().prepare(`UPDATE memory_projection_jobs SET state=?,next_attempt_at=?,last_error=?,lease_token=NULL,lease_until=NULL
    WHERE id=? AND lease_token=? AND state='running'`).run(job.attempts >= 8 ? 'failed' : 'pending',
      now + Math.min(3600_000, 1000 * 2 ** Math.min(job.attempts, 12)), code, job.id, job.lease_token);
}
export function memoryProjectionStats(): { pending: number; failed: number; running: number; completed: number; oldestPendingAt: number | null; lastCompletedAt: number | null } {
  const row = getDb().prepare(`SELECT SUM(state='pending') pending,SUM(state='failed') failed,SUM(state='running') running,
    SUM(state='done') completed,MIN(CASE WHEN state IN ('pending','running') THEN created_at END) oldestPendingAt,MAX(completed_at) lastCompletedAt
    FROM memory_projection_jobs`).get() as Record<string, number | null>;
  return { pending: row['pending'] ?? 0, failed: row['failed'] ?? 0, running: row['running'] ?? 0,
    completed: row['completed'] ?? 0, oldestPendingAt: row['oldestPendingAt'] ?? null, lastCompletedAt: row['lastCompletedAt'] ?? null };
}

/** Operator retry; preserves body/version/model and never reopens tombstones. */
export function retryFailedMemoryProjections(limit = 100): number {
  const e = env();
  return getDb().prepare(`UPDATE memory_projection_jobs SET state='pending',attempts=0,next_attempt_at=?,last_error=NULL
    WHERE id IN (SELECT j.id FROM memory_projection_jobs j JOIN memory_sources s ON s.source_id=j.source_id
      WHERE j.state='failed' AND j.version=s.version AND j.model=? AND j.collection=? ORDER BY j.id LIMIT ?)`)
    .run(Date.now(), e.MEMORY_EMBED_MODEL, e.MEMORY_COLLECTION, Math.max(1, Math.min(1000, Math.floor(limit)))).changes;
}
