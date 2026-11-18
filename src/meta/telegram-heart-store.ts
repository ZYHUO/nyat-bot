import { randomUUID } from 'node:crypto';
import { getDb } from '../db/sqlite.js';
import { canonicalJson, eventHash } from '../shared/event-identity.js';
import type { FormattedMessage } from '../shared/types.js';
import type { AttentionLayer } from './types.js';

export interface TelegramHeartCandidate {
  chatId: number;
  formatted: FormattedMessage;
  layer: AttentionLayer;
  addressed: boolean;
  ongoingFollowup?: boolean;
  cognitiveAnchorEventId?: string;
}
export interface TelegramHeartScope { key: string; chatKey: string; chatId: number; threadId: number; accountId: string }
export interface TelegramHeartEntry { sequence: number; eventId: string; scope: TelegramHeartScope; item: TelegramHeartCandidate | null; state: string; attempts: number }
export interface TelegramHeartClaim { chatKey: string; scopeKey: string; owner: string; version: number }
export interface TelegramHeartRecheckTicket { scope: TelegramHeartScope; token: string }
type RecheckAdmission = { status: 'claimed'; claim: TelegramHeartClaim }
  | { status: 'reserved' | 'occupied' | 'capacity' | 'obsolete' };
interface ClaimRow { chat_key: string; scope_key: string; owner: string | null; version: number; lease_until_ms: number; invalidated: number; effects_started: number; cancel_reason: string | null }
const LEASE_MS = 90_000;
const WAIT_RESERVATION_LEASE_MS = 5_000;
const MAX_ACTIVE_CLAIMS = 4;
const MAX_WAIT_WORK = 2;
const MAX_ATTEMPTS = 3;
const MAX_PENDING = 4096;
const MAX_SCOPE_PENDING = 128;

function transaction<T>(run: () => T): T {
  const db = getDb();
  if (db.inTransaction) return db.transaction(run)();
  const previous = Number(db.pragma('synchronous', { simple: true }));
  db.pragma('synchronous = FULL');
  // Take the writer lock before reading competing reservations/leases. A
  // deferred WAL read transaction cannot always upgrade after a peer commits.
  try { return db.transaction(run).immediate(); }
  finally { db.pragma(`synchronous = ${previous}`); }
}

/** Identity comes from authenticated intake, never a model-selected target. */
export function telegramHeartScope(item: TelegramHeartCandidate): TelegramHeartScope {
  const identity = item.formatted.eventIdentity;
  const ref = identity?.ref.conversation;
  const threadId = item.formatted.messageThreadId ?? 0;
  if (!Number.isSafeInteger(item.chatId) || item.chatId >= 0 || !identity || !ref
    || ref.platform !== 'telegram' || ref.idNamespace !== 'telegram' || ref.conversationKind !== 'group'
    || ref.id !== String(item.chatId) || !/^[1-9]\d*$/.test(ref.accountId)
    || !Number.isSafeInteger(threadId) || threadId < 0 || Number(ref.threadId ?? 0) !== threadId
    || identity.ref.id !== String(item.formatted.messageId) || !/^[a-f0-9]{64}$/.test(identity.eventId)
    || !Number.isSafeInteger(identity.receivedAt) || identity.receivedAt <= 0) throw new Error('telegram_heart_scope_invalid');
  return { key: eventHash(canonicalJson([ref.accountId, item.chatId, threadId])),
    chatKey: eventHash(canonicalJson([ref.accountId, item.chatId])), chatId: item.chatId, threadId, accountId: ref.accountId };
}

function decode(row: Record<string, unknown>): TelegramHeartEntry {
  const state = String(row['state']);
  const item = state === 'pending' || state === 'evaluating' ? JSON.parse(String(row['payload_json'])) as TelegramHeartCandidate : null;
  const scope = { key: String(row['scope_key']), chatKey: String(row['chat_key']), chatId: Number(row['chat_id']),
    accountId: String(row['account_id']), threadId: Number(row['thread_id']) };
  if (item && telegramHeartScope(item).key !== scope.key) throw new Error('telegram_heart_stored_scope_invalid');
  return { sequence: Number(row['sequence']), eventId: String(row['event_id']), scope, item, state, attempts: Number(row['attempts']) };
}
function claimRow(chatKey: string): ClaimRow | undefined {
  return getDb().prepare('SELECT * FROM telegram_heart_claims WHERE chat_key=?').get(chatKey) as ClaimRow | undefined;
}
function matches(row: ClaimRow | undefined, claim: TelegramHeartClaim): row is ClaimRow {
  return !!row && row.owner === claim.owner && row.version === claim.version && row.scope_key === claim.scopeKey;
}
function relatedRevision(old: TelegramHeartCandidate, next: TelegramHeartCandidate): boolean {
  const a = old.formatted, b = next.formatted;
  if (a.eventIdentity?.messageKey === b.eventIdentity?.messageKey
    && a.eventIdentity?.revision !== b.eventIdentity?.revision) return true;
  return !!a.pendingIntent && !!b.pendingIntent && a.pendingIntent.laneKey === b.pendingIntent.laneKey
    && (a.pendingIntent.intentId !== b.pendingIntent.intentId || b.pendingIntent.revision > a.pendingIntent.revision);
}

/** Recovery never replays an attempt that may already have reacted or published attention. */
function expireClaims(): void {
  const db = getDb();
  db.prepare('DELETE FROM telegram_heart_wait_reservations WHERE lease_until_ms<=?').run(Date.now());
  const expired = db.prepare('SELECT * FROM telegram_heart_claims WHERE owner IS NOT NULL AND lease_until_ms<=?')
    .all(Date.now()) as ClaimRow[];
  for (const row of expired) {
    finishRows(row, row.effects_started ? 'unknown' : 'pending', 'owner_expired');
    db.prepare('UPDATE telegram_heart_claims SET owner=NULL,lease_until_ms=0 WHERE chat_key=? AND owner=? AND version=?')
      .run(row.chat_key, row.owner, row.version);
  }
}
function finishRows(row: ClaimRow, state: 'pending' | 'settled' | 'unknown' | 'held', reason: string): void {
  const db = getDb();
  const entries = db.prepare("SELECT event_id,attempts FROM telegram_heart_candidates WHERE owner=? AND state='evaluating'")
    .all(row.owner) as Array<{ event_id: string; attempts: number }>;
  for (const entry of entries) {
    const exhausted = state === 'pending' && entry.attempts >= MAX_ATTEMPTS;
    const next = exhausted ? 'held' : state;
    db.prepare(`UPDATE telegram_heart_candidates SET state=?,owner=NULL,reason=?,
      payload_json=CASE WHEN ?='pending' THEN payload_json ELSE '{}' END WHERE event_id=? AND owner=?`)
      .run(next, exhausted ? 'evaluation_retry_exhausted' : reason, next, entry.event_id, row.owner);
  }
}

/** false means storage capacity refused acceptance, not that a decision was completed. */
export function acceptTelegramHeartCandidate(item: TelegramHeartCandidate): TelegramHeartEntry | null {
  const scope = telegramHeartScope(item), eventId = item.formatted.eventIdentity!.eventId;
  const payload = canonicalJson(item);
  if (Buffer.byteLength(payload) > 256 * 1024) throw new Error('telegram_heart_payload_too_large');
  return transaction(() => {
    const db = getDb(); expireClaims();
    const old = db.prepare('SELECT * FROM telegram_heart_candidates WHERE event_id=?').get(eventId) as Record<string, unknown> | undefined;
    if (old) {
      const entry = decode(old);
      if (entry.scope.key !== scope.key) throw new Error('telegram_heart_identity_collision');
      return entry; // The first accepted source body is authoritative on retransmission.
    }
    const count = db.prepare("SELECT COUNT(*) AS total,SUM(scope_key=?) AS scoped FROM telegram_heart_candidates WHERE state IN ('pending','evaluating')")
      .get(scope.key) as { total: number; scoped: number | null };
    if (count.total >= MAX_PENDING || (count.scoped ?? 0) >= MAX_SCOPE_PENDING) return null;
    db.prepare('INSERT INTO telegram_heart_candidates(event_id,scope_key,chat_key,chat_id,account_id,thread_id,received_at_ms,payload_json) VALUES(?,?,?,?,?,?,?,?)')
      .run(eventId, scope.key, scope.chatKey, scope.chatId, scope.accountId, scope.threadId, item.formatted.eventIdentity!.receivedAt, payload);
    db.prepare('DELETE FROM telegram_heart_wait_reservations WHERE chat_key=? AND scope_key=?').run(scope.chatKey, scope.key);
    const row = claimRow(scope.chatKey);
    if (row?.owner && row.scope_key === scope.key) {
      const active = db.prepare("SELECT payload_json FROM telegram_heart_candidates WHERE owner=? AND state='evaluating'")
        .all(row.owner) as Array<{ payload_json: string }>;
      if (row.owner.startsWith('wake:') || active.some(entry => relatedRevision(JSON.parse(entry.payload_json) as TelegramHeartCandidate, item))) {
        db.prepare("UPDATE telegram_heart_claims SET invalidated=1,cancel_reason='source_revision' WHERE chat_key=? AND owner=? AND version=?")
          .run(scope.chatKey, row.owner, row.version);
      }
    }
    return decode(db.prepare('SELECT * FROM telegram_heart_candidates WHERE event_id=?').get(eventId) as Record<string, unknown>);
  });
}

export function listPendingTelegramHeart(after = 0, limit = 64): TelegramHeartEntry[] {
  return transaction(() => {
    expireClaims();
    return (getDb().prepare("SELECT * FROM telegram_heart_candidates WHERE state='pending' AND sequence>? ORDER BY sequence LIMIT ?")
      .all(after, Math.min(256, Math.max(1, limit))) as Array<Record<string, unknown>>).map(decode);
  });
}
export function getTelegramHeartEntry(eventId: string): TelegramHeartEntry | null {
  const row = getDb().prepare('SELECT * FROM telegram_heart_candidates WHERE event_id=?').get(eventId) as Record<string, unknown> | undefined;
  return row ? decode(row) : null;
}
export function holdTelegramHeartCandidate(eventId: string, reason: string): void {
  getDb().prepare("UPDATE telegram_heart_candidates SET state='held',reason=?,payload_json='{}' WHERE event_id=? AND state='pending'").run(reason, eventId);
}

/** Called inside the same write transaction as the candidate check. Both fresh
 * input and expiry use this single account/chat seat, including across topics. */
function claimChat(scope: TelegramHeartScope, wake: boolean): TelegramHeartClaim | null {
  const db = getDb();
  const old = claimRow(scope.chatKey);
  if (old?.owner) return null;
  const { active } = db.prepare('SELECT COUNT(*) AS active FROM telegram_heart_claims WHERE owner IS NOT NULL').get() as { active: number };
  if (active >= MAX_ACTIVE_CLAIMS) return null;
  if (!wake) {
    const now = Date.now();
    // One runnable reservation may take the last free model slot even if
    // other chats continuously enqueue. The remaining slots serve fresh work.
    const blocked = db.prepare(`SELECT 1 FROM telegram_heart_wait_reservations w
      WHERE w.fresh_turn_until_ms BETWEEN 0 AND ? AND (w.chat_key=? OR (?=1 AND NOT EXISTS (
        SELECT 1 FROM telegram_heart_claims c WHERE c.chat_key=w.chat_key AND c.owner IS NOT NULL))) LIMIT 1`)
      .get(now, scope.chatKey, Number(active === MAX_ACTIVE_CLAIMS - 1));
    if (blocked) return null;
    db.prepare('UPDATE telegram_heart_wait_reservations SET fresh_turn_until_ms=0 WHERE chat_key=?').run(scope.chatKey);
  }
  const owner = (wake ? 'wake:' : '') + randomUUID();
  const version = (old?.version ?? 0) + 1;
  getDb().prepare(`INSERT INTO telegram_heart_claims(chat_key,scope_key,owner,version,lease_until_ms,invalidated,effects_started,cancel_reason)
    VALUES(?,?,?,?,?,0,0,NULL) ON CONFLICT(chat_key) DO UPDATE SET scope_key=excluded.scope_key,owner=excluded.owner,
    version=excluded.version,lease_until_ms=excluded.lease_until_ms,invalidated=0,effects_started=0,cancel_reason=NULL`)
    .run(scope.chatKey, scope.key, owner, version, Date.now() + LEASE_MS);
  return { chatKey: scope.chatKey, scopeKey: scope.key, owner, version };
}

/** Redis claims each timer generation once. This ticket schedules that worker's
 * pure evaluation; it carries neither a source body nor permission to reply. */
export function claimTelegramHeartRecheck(ticket: TelegramHeartRecheckTicket, registered: boolean): RecheckAdmission {
  const { scope, token } = ticket;
  return transaction(() => {
    const db = getDb(), now = Date.now();
    expireClaims();
    const row = db.prepare('SELECT token,fresh_turn_until_ms FROM telegram_heart_wait_reservations WHERE chat_key=?')
      .get(scope.chatKey) as { token: string; fresh_turn_until_ms: number } | undefined;
    if (registered && row?.token !== token) return { status: 'obsolete' };
    if (row && row.token !== token) return { status: 'occupied' };
    let freshTurn = row?.fresh_turn_until_ms ?? -1;
    if (!row) {
      // A pending fresh decision in this very topic will re-read its context.
      if (db.prepare("SELECT 1 FROM telegram_heart_candidates WHERE scope_key=? AND state='pending' LIMIT 1")
        .get(scope.key)) return { status: 'obsolete' };
      const { count } = db.prepare(`SELECT (SELECT COUNT(*) FROM telegram_heart_wait_reservations)
        + (SELECT COUNT(*) FROM telegram_heart_claims WHERE owner GLOB 'wake:*') AS count`).get() as { count: number };
      if (count >= MAX_WAIT_WORK) return { status: 'capacity' };
      const owner = claimRow(scope.chatKey)?.owner;
      // After an active fresh batch WAIT is next. Otherwise give a waiting
      // fresh batch one turn before WAIT; an absent fresh worker gets a grace
      // period, never an unbounded veto. -1 starts that period upon release.
      freshTurn = owner && !owner.startsWith('wake:') ? 0 : -1;
      db.prepare('INSERT INTO telegram_heart_wait_reservations(chat_key,scope_key,token,lease_until_ms,fresh_turn_until_ms) VALUES(?,?,?,?,?)')
        .run(scope.chatKey, scope.key, token, now + WAIT_RESERVATION_LEASE_MS, freshTurn);
    } else {
      db.prepare('UPDATE telegram_heart_wait_reservations SET lease_until_ms=? WHERE chat_key=? AND token=?')
        .run(now + WAIT_RESERVATION_LEASE_MS, scope.chatKey, token);
    }
    if (claimRow(scope.chatKey)?.owner) return { status: 'reserved' };
    if (freshTurn !== 0 && db.prepare("SELECT 1 FROM telegram_heart_candidates WHERE chat_key=? AND state='pending' LIMIT 1").get(scope.chatKey)) {
      if (freshTurn === -1) {
        db.prepare('UPDATE telegram_heart_wait_reservations SET fresh_turn_until_ms=? WHERE chat_key=?').run(now + 1_000, scope.chatKey);
        return { status: 'reserved' };
      }
      if (freshTurn > now) return { status: 'reserved' };
    }
    // Publish readiness for global fairness even when all slots are occupied.
    if (freshTurn !== 0) db.prepare('UPDATE telegram_heart_wait_reservations SET fresh_turn_until_ms=0 WHERE chat_key=?').run(scope.chatKey);
    const claim = claimChat(scope, true);
    if (!claim) return { status: 'reserved' };
    releaseTelegramHeartRecheck(ticket);
    return { status: 'claimed', claim };
  });
}

export function releaseTelegramHeartRecheck({ scope, token }: TelegramHeartRecheckTicket): void {
  getDb().prepare('DELETE FROM telegram_heart_wait_reservations WHERE chat_key=? AND token=?').run(scope.chatKey, token);
}

export function claimTelegramHeartBatch(entries: TelegramHeartEntry[]): TelegramHeartClaim | null {
  if (!entries.length) return null;
  const scope = entries[0]!.scope;
  if (entries.some(entry => entry.scope.key !== scope.key)) throw new Error('cross_scope_heart_claim');
  return transaction(() => {
    const db = getDb(); expireClaims();
    const rows = entries.map(entry => db.prepare("SELECT state FROM telegram_heart_candidates WHERE event_id=? AND scope_key=?")
      .get(entry.eventId, scope.key) as { state: string } | undefined);
    if (rows.some(row => row?.state !== 'pending')) return null;
    const claim = claimChat(scope, false);
    if (!claim) return null;
    const update = db.prepare("UPDATE telegram_heart_candidates SET state='evaluating',owner=?,attempts=attempts+1 WHERE event_id=? AND state='pending'");
    for (const entry of entries) update.run(claim.owner, entry.eventId);
    return claim;
  });
}

/** Keep the seat until a cancelled model call actually returns. Renewal does
 * not restore permission to act and cannot revive an expired lease. */
export function renewTelegramHeartClaimOwnership(claim: TelegramHeartClaim): boolean {
  const now = Date.now();
  return getDb().prepare(`UPDATE telegram_heart_claims SET lease_until_ms=?
    WHERE chat_key=? AND scope_key=? AND owner=? AND version=? AND lease_until_ms>?`)
    .run(now + LEASE_MS, claim.chatKey, claim.scopeKey, claim.owner, claim.version, now).changes === 1;
}
export function checkTelegramHeartClaim(claim: TelegramHeartClaim, beginEffects = false): boolean {
  const row = claimRow(claim.chatKey);
  if (!matches(row, claim) || row.invalidated || row.lease_until_ms <= Date.now()) return false;
  // Model and policy checks are reads. Only the first side effect needs a
  // durable write; the heartbeat owns lease renewal.
  if (!beginEffects || row.effects_started) return true;
  return transaction(() => getDb().prepare(`UPDATE telegram_heart_claims SET effects_started=1
    WHERE chat_key=? AND scope_key=? AND owner=? AND version=? AND invalidated=0 AND lease_until_ms>?`)
    .run(claim.chatKey, claim.scopeKey, claim.owner, claim.version, Date.now()).changes === 1);
}
export function finishTelegramHeartBatch(claim: TelegramHeartClaim, outcome: 'settled' | 'aborted' | 'failed'): void {
  transaction(() => {
    const row = claimRow(claim.chatKey);
    if (!matches(row, claim)) return;
    const ended = outcome === 'settled' && !row.invalidated && row.lease_until_ms > Date.now();
    finishRows(row, ended ? 'settled' : row.effects_started ? 'unknown' : 'pending',
      ended ? 'decision_completed' : row.cancel_reason ?? outcome);
    getDb().prepare('UPDATE telegram_heart_claims SET owner=NULL,lease_until_ms=0 WHERE chat_key=? AND owner=? AND version=?')
      .run(claim.chatKey, claim.owner, claim.version);
  });
}
export function interruptTelegramHeartScope(scope: TelegramHeartScope): void {
  transaction(() => {
    getDb().prepare('DELETE FROM telegram_heart_wait_reservations WHERE chat_key=? AND scope_key=?').run(scope.chatKey, scope.key);
    getDb().prepare("UPDATE telegram_heart_claims SET invalidated=1,cancel_reason='direct_input' WHERE scope_key=? AND owner IS NOT NULL").run(scope.key);
  });
}
