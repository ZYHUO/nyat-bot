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
  /** First WAIT deadline, restored only from the durable source row. */
  waitUntilMs?: number;
  cognitiveAnchorEventId?: string;
}
export interface TelegramHeartScope { key: string; chatKey: string; chatId: number; threadId: number; accountId: string }
export interface TelegramHeartEntry { sequence: number; eventId: string; scope: TelegramHeartScope; item: TelegramHeartCandidate | null; state: string; attempts: number }
export interface TelegramHeartClaim { chatKey: string; scopeKey: string; owner: string; version: number; scopeVersion: number }
export interface TelegramHeartRecheckTicket { scope: TelegramHeartScope; token: string }
type RecheckAdmission = { status: 'claimed'; claim: TelegramHeartClaim }
  | { status: 'reserved' | 'occupied' | 'capacity' | 'obsolete' };
interface ClaimRow { chat_key: string; scope_key: string; owner: string | null; version: number; lease_until_ms: number; invalidated: number; effects_started: number; cancel_reason: string | null }
const LEASE_MS = 90_000;
const WAIT_RESERVATION_LEASE_MS = 5_000;
const MAX_ACTIVE_CLAIMS = 4;
const MAX_WAIT_WORK = 2;
const MAX_ATTEMPTS = 3;
export const TELEGRAM_HEART_BATCH_LIMIT = 32;
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

export { transaction as telegramHeartTransaction };

export function telegramHeartScopeKey(accountId: string, chatId: number, threadId: number): string {
  return eventHash(canonicalJson([accountId, chatId, threadId]));
}
function bumpScopeVersion(scopeKey: string, direct = false): void {
  getDb().prepare(`INSERT INTO telegram_heart_scope_versions(scope_key,version,cancel_version) VALUES(?,1,?)
    ON CONFLICT(scope_key) DO UPDATE SET version=version+1,cancel_version=cancel_version+excluded.cancel_version`)
    .run(scopeKey, Number(direct));
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
  return { key: telegramHeartScopeKey(ref.accountId, item.chatId, threadId),
    chatKey: eventHash(canonicalJson([ref.accountId, item.chatId])), chatId: item.chatId, threadId, accountId: ref.accountId };
}

function decode(row: Record<string, unknown>): TelegramHeartEntry {
  const state = String(row['state']);
  const item = state === 'pending' || state === 'evaluating' ? JSON.parse(String(row['payload_json'])) as TelegramHeartCandidate : null;
  if (item) {
    delete item.waitUntilMs;
    if (row['wait_until_ms'] != null) item.waitUntilMs = Number(row['wait_until_ms']);
  }
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
  // A successfully deferred source is still linked to this claim until its
  // physical processor drains. It was explicitly excluded from any effects.
  db.prepare("UPDATE telegram_heart_candidates SET owner=NULL WHERE scope_key=? AND state='pending' AND owner=?").run(row.scope_key, row.owner);
  const entries = db.prepare("SELECT event_id,attempts FROM telegram_heart_candidates WHERE scope_key=? AND state='evaluating' AND owner=?")
    .all(row.scope_key, row.owner) as Array<{ event_id: string; attempts: number }>;
  for (const entry of entries) {
    const exhausted = state === 'pending' && entry.attempts >= MAX_ATTEMPTS;
    const next = exhausted ? 'held' : state;
    db.prepare(`UPDATE telegram_heart_candidates SET state=?,owner=NULL,reason=?,
      payload_json=CASE WHEN ?='pending' THEN payload_json ELSE '{}' END WHERE event_id=? AND owner=?`)
      .run(next, exhausted ? 'evaluation_retry_exhausted' : reason, next, entry.event_id, row.owner);
  }
}

/** Read under the authority writer transaction before admitting pending work. */
export function hasTelegramHeartCapacity(scopeKey: string): boolean {
  const count = getDb().prepare("SELECT COUNT(*) AS total,SUM(scope_key=?) AS scoped FROM telegram_heart_candidates WHERE state IN ('pending','evaluating')")
    .get(scopeKey) as { total: number; scoped: number | null };
  return count.total < MAX_PENDING && (count.scoped ?? 0) < MAX_SCOPE_PENDING;
}

/** false means storage capacity refused acceptance, not that a decision was completed. */
export function acceptTelegramHeartCandidate(item: TelegramHeartCandidate): TelegramHeartEntry | null {
  const scope = telegramHeartScope(item), eventId = item.formatted.eventIdentity!.eventId;
  const source = { ...item };
  delete source.waitUntilMs;
  const payload = canonicalJson(source);
  if (Buffer.byteLength(payload) > 256 * 1024) throw new Error('telegram_heart_payload_too_large');
  return transaction(() => {
    const db = getDb(); expireClaims();
    const old = db.prepare('SELECT * FROM telegram_heart_candidates WHERE event_id=?').get(eventId) as Record<string, unknown> | undefined;
    if (old) {
      const entry = decode(old);
      if (entry.scope.key !== scope.key) throw new Error('telegram_heart_identity_collision');
      return entry; // The first accepted source body is authoritative on retransmission.
    }
    if (!hasTelegramHeartCapacity(scope.key)) {
      // Intake has already recorded the human message in the topic context.
      // Revoke existing approvals without enqueueing work or creating a scope
      // for a topic with no previous approval when global capacity is exhausted.
      db.prepare('UPDATE telegram_heart_scope_versions SET version=version+1 WHERE scope_key=?').run(scope.key);
      return null;
    }
    db.prepare('INSERT INTO telegram_heart_candidates(event_id,scope_key,chat_key,chat_id,account_id,thread_id,received_at_ms,payload_json) VALUES(?,?,?,?,?,?,?,?)')
      .run(eventId, scope.key, scope.chatKey, scope.chatId, scope.accountId, scope.threadId, item.formatted.eventIdentity!.receivedAt, payload);
    bumpScopeVersion(scope.key);
    db.prepare("DELETE FROM telegram_heart_wait_reservations WHERE chat_key=? AND scope_key=? AND token NOT GLOB 'source:*'").run(scope.chatKey, scope.key);
    const row = claimRow(scope.chatKey);
    if (row?.owner && row.scope_key === scope.key) {
      const active = db.prepare("SELECT payload_json,wait_until_ms FROM telegram_heart_candidates WHERE scope_key=? AND state IN ('pending','evaluating') AND owner=?")
        .all(row.scope_key, row.owner) as Array<{ payload_json: string; wait_until_ms: number | null }>;
      if (row.owner.startsWith('wake:') || active.some(entry => entry.wait_until_ms !== null
        || relatedRevision(JSON.parse(entry.payload_json) as TelegramHeartCandidate, item))) {
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
/** Prioritize already due sources on restart even if an earlier page contains
 * many future timers. The sequence cursor still visits every pending source. */
export function listDueTelegramHeartWaits(): TelegramHeartEntry[] {
  return (getDb().prepare(`SELECT * FROM telegram_heart_candidates INDEXED BY idx_telegram_heart_due WHERE state='pending'
    AND owner IS NULL AND wait_until_ms<=? ORDER BY wait_until_ms,sequence LIMIT 64`)
    .all(Date.now()) as Array<Record<string, unknown>>).map(decode);
}
export function nextTelegramHeartWait(scope: TelegramHeartScope): TelegramHeartEntry | null {
  const row = getDb().prepare(`SELECT * FROM telegram_heart_candidates WHERE scope_key=? AND state='pending'
    AND owner IS NULL AND wait_until_ms IS NOT NULL ORDER BY wait_until_ms,sequence LIMIT 1`)
    .get(scope.key) as Record<string, unknown> | undefined;
  return row ? decode(row) : null;
}
export function holdTelegramHeartCandidate(eventId: string, reason: string): void {
  getDb().prepare("UPDATE telegram_heart_candidates SET state='held',reason=?,payload_json='{}' WHERE event_id=? AND state='pending'").run(reason, eventId);
}

/** Called inside the same write transaction as the candidate check. Both fresh
 * input and expiry use this single account/chat seat, including across topics. */
function claimChat(scope: TelegramHeartScope, kind: 'fresh' | 'wake' | 'source'): TelegramHeartClaim | null {
  const db = getDb();
  const old = claimRow(scope.chatKey);
  if (old?.owner) return null;
  const { active } = db.prepare('SELECT COUNT(*) AS active FROM telegram_heart_claims WHERE owner IS NOT NULL').get() as { active: number };
  if (active >= MAX_ACTIVE_CLAIMS) return null;
  if (kind === 'fresh') {
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
  const owner = (kind === 'fresh' ? '' : kind + ':') + randomUUID();
  const version = (old?.version ?? 0) + 1;
  getDb().prepare(`INSERT INTO telegram_heart_claims(chat_key,scope_key,owner,version,lease_until_ms,invalidated,effects_started,cancel_reason)
    VALUES(?,?,?,?,?,0,0,NULL) ON CONFLICT(chat_key) DO UPDATE SET scope_key=excluded.scope_key,owner=excluded.owner,
    version=excluded.version,lease_until_ms=excluded.lease_until_ms,invalidated=0,effects_started=0,cancel_reason=NULL`)
    .run(scope.chatKey, scope.key, owner, version, Date.now() + LEASE_MS);
  const revision = db.prepare('SELECT version FROM telegram_heart_scope_versions WHERE scope_key=?').get(scope.key) as { version: number } | undefined;
  return { chatKey: scope.chatKey, scopeKey: scope.key, owner, version, scopeVersion: revision?.version ?? 0 };
}

/** Redis claims each timer generation once. This ticket schedules that worker's
 * pure evaluation; it carries neither a source body nor permission to reply. */
export function claimTelegramHeartRecheck(ticket: TelegramHeartRecheckTicket, registered: boolean): RecheckAdmission {
  return transaction(() => reserveRecheck(ticket, registered, false));
}

/** Both the legacy transport and durable source expiry share this class
 * budget, last-slot fairness and one physical per-chat lease. */
function reserveRecheck(ticket: TelegramHeartRecheckTicket, registered: boolean, sourceWait: boolean): RecheckAdmission {
  const { scope, token } = ticket;
  const db = getDb(), now = Date.now();
  expireClaims();
  const row = db.prepare('SELECT token,fresh_turn_until_ms FROM telegram_heart_wait_reservations WHERE chat_key=?')
    .get(scope.chatKey) as { token: string; fresh_turn_until_ms: number } | undefined;
  if (registered && row?.token !== token) return { status: 'obsolete' };
  if (row && row.token !== token) return { status: 'occupied' };
  let freshTurn = row?.fresh_turn_until_ms ?? -1;
  if (!row) {
    // A pending fresh decision in this very topic will re-read its context.
    if (!sourceWait && db.prepare("SELECT 1 FROM telegram_heart_candidates WHERE scope_key=? AND state='pending' AND wait_until_ms IS NULL LIMIT 1")
      .get(scope.key)) return { status: 'obsolete' };
    const { count } = db.prepare(`SELECT (SELECT COUNT(*) FROM telegram_heart_wait_reservations)
      + (SELECT COUNT(*) FROM telegram_heart_claims WHERE owner GLOB 'wake:*' OR owner GLOB 'source:*') AS count`).get() as { count: number };
    if (count >= MAX_WAIT_WORK) return { status: 'capacity' };
    const owner = claimRow(scope.chatKey)?.owner;
    // After an active fresh batch WAIT is next. Otherwise give a waiting
    // fresh batch one turn before WAIT; an absent fresh worker gets a grace
    // period, never an unbounded veto. -1 starts that period upon release.
    freshTurn = owner && !owner.includes(':') ? 0 : -1;
    db.prepare('INSERT INTO telegram_heart_wait_reservations(chat_key,scope_key,token,lease_until_ms,fresh_turn_until_ms) VALUES(?,?,?,?,?)')
      .run(scope.chatKey, scope.key, token, now + WAIT_RESERVATION_LEASE_MS, freshTurn);
  } else {
    db.prepare('UPDATE telegram_heart_wait_reservations SET lease_until_ms=? WHERE chat_key=? AND token=?')
      .run(now + WAIT_RESERVATION_LEASE_MS, scope.chatKey, token);
  }
  if (claimRow(scope.chatKey)?.owner) return { status: 'reserved' };
  if (freshTurn !== 0 && db.prepare("SELECT 1 FROM telegram_heart_candidates WHERE chat_key=? AND state='pending' AND wait_until_ms IS NULL LIMIT 1").get(scope.chatKey)) {
    if (freshTurn === -1) {
      db.prepare('UPDATE telegram_heart_wait_reservations SET fresh_turn_until_ms=? WHERE chat_key=?').run(now + 1_000, scope.chatKey);
      return { status: 'reserved' };
    }
    if (freshTurn > now) return { status: 'reserved' };
  }
  // Publish readiness for global fairness even when all slots are occupied.
  if (freshTurn !== 0) db.prepare('UPDATE telegram_heart_wait_reservations SET fresh_turn_until_ms=0 WHERE chat_key=?').run(scope.chatKey);
  const claim = claimChat(scope, sourceWait ? 'source' : 'wake');
  if (!claim) return { status: 'reserved' };
  releaseTelegramHeartRecheck(ticket);
  return { status: 'claimed', claim };
}

export function releaseTelegramHeartRecheck({ scope, token }: TelegramHeartRecheckTicket): void {
  getDb().prepare('DELETE FROM telegram_heart_wait_reservations WHERE chat_key=? AND token=?').run(scope.chatKey, token);
}

/** Fetch bodies again under the writer lock: disposable hints from another
 * process are never permission to claim a source that is now waiting. */
export function claimTelegramHeartBatch(hints: TelegramHeartEntry[], sourceWait = false):
  (TelegramHeartClaim & { entries: TelegramHeartEntry[] }) | null {
  if (!hints.length || hints.length > TELEGRAM_HEART_BATCH_LIMIT) return null;
  const scope = hints[0]!.scope;
  if (hints.some(entry => entry.scope.key !== scope.key)) throw new Error('cross_scope_heart_claim');
  return transaction(() => {
    const db = getDb(), now = Date.now(); expireClaims();
    // A duplicate scheduler can retry a blocked hint at 250 ms intervals.
    if (!sourceWait && claimRow(scope.chatKey)?.owner) return null;
    const pending = (db.prepare(`SELECT event_id,wait_until_ms,reviewed_early FROM telegram_heart_candidates
      WHERE scope_key=? AND state='pending' AND owner IS NULL ORDER BY sequence`)
      .all(scope.key) as Array<Record<string, unknown>>);
    // At most 128 live rows per scope. Decode bodies only after admission;
    // retries of a blocked hint must not reparse an entire hot scope.
    const hintIds = new Set(hints.map(entry => entry.eventId));
    const fresh = pending.filter(row => row['wait_until_ms'] == null);
    const due = pending.filter(row => row['wait_until_ms'] != null && Number(row['wait_until_ms']) <= now)
      .sort((a, b) => Number(a['wait_until_ms']) - Number(b['wait_until_ms']));
    const seeds = sourceWait ? due : fresh.filter(row => hintIds.has(String(row['event_id'])));
    if (!seeds.length || (sourceWait ? !seeds.some(row => hintIds.has(String(row['event_id']))) : seeds.length !== hintIds.size)) return null;
    let claim: TelegramHeartClaim | null;
    if (sourceWait) {
      const result = reserveRecheck({ scope, token: 'source:' + scope.key }, false, true);
      claim = result.status === 'claimed' ? result.claim : null;
    } else claim = claimChat(scope, 'fresh');
    if (!claim) return null;

    // A newly arrived supplement can close its author's question or the
    // specific question it quotes. An unrelated author's future WAIT keeps
    // its own turn. Each source may join at most one speculative early review.
    const hydrate = (row: Record<string, unknown>): TelegramHeartEntry => getTelegramHeartEntry(String(row['event_id']))!;
    const limit = TELEGRAM_HEART_BATCH_LIMIT;
    let selected: TelegramHeartEntry[];
    if (sourceWait) {
      // Include already accepted evidence when a deadline and the quiet timer
      // race. Always reserve a seat for due work and cap this as WAIT work.
      const expired = seeds.slice(0, fresh.length ? limit / 2 : limit);
      selected = [...expired, ...fresh.slice(0, limit - expired.length)].map(hydrate);
    } else {
      selected = seeds.map(hydrate);
      const authors = new Set(selected.map(entry => entry.item!.formatted.uid));
      const replies = new Set(selected.map(entry => entry.item!.formatted.replyTo?.messageId));
      const future = pending.filter(row => Number(row['wait_until_ms']) > now && !row['reviewed_early']);
      for (const row of [...due, ...future]) {
        if (selected.length >= limit) break;
        const entry = hydrate(row), message = entry.item!.formatted;
        if (entry.item!.waitUntilMs! <= now || authors.has(message.uid) || replies.has(message.messageId)) selected.push(entry);
      }
    }
    selected.sort((a, b) => a.sequence - b.sequence);
    const update = db.prepare(`UPDATE telegram_heart_candidates SET state='evaluating',owner=?,attempts=attempts+1,
      reviewed_early=CASE WHEN wait_until_ms>? THEN 1 ELSE reviewed_early END WHERE event_id=?`);
    for (const entry of selected) update.run(claim.owner, now, entry.eventId);
    // A fresh cohort can consume a due source during the reserved fresh turn.
    // If no due work remains, that reservation must immediately release its seat.
    if (due.length && !db.prepare(`SELECT 1 FROM telegram_heart_candidates WHERE scope_key=?
      AND state='pending' AND wait_until_ms<=? LIMIT 1`).get(scope.key, now)) {
      releaseTelegramHeartRecheck({ scope, token: 'source:' + scope.key });
    }
    return { ...claim, entries: selected };
  });
}

/** Atomically keep a validated subset of an evaluation in the same source
 * rows. A repeated WAIT cannot extend its first deadline or rearm expiry.
 * Owners are retained so related revisions still invalidate in-flight work. */
export function deferTelegramHeartSources(claim: TelegramHeartClaim, messageIds: readonly number[], waitSec: number): boolean {
  if (!messageIds.length || messageIds.length > TELEGRAM_HEART_BATCH_LIMIT || new Set(messageIds).size !== messageIds.length
    || !messageIds.every(id => Number.isSafeInteger(id) && id > 0) || !Number.isSafeInteger(waitSec) || waitSec <= 0) return false;
  return transaction(() => {
    const db = getDb(), now = Date.now(), row = claimRow(claim.chatKey);
    if (!matches(row, claim) || row.invalidated || row.effects_started || row.lease_until_ms <= now) return false;
    const selected = new Map<number, TelegramHeartEntry>();
    const rows = db.prepare("SELECT * FROM telegram_heart_candidates WHERE owner=? AND scope_key=? AND state='evaluating' ORDER BY sequence")
      .all(claim.owner, claim.scopeKey) as Array<Record<string, unknown>>;
    for (const value of rows) {
      const entry = decode(value);
      selected.set(entry.item!.formatted.messageId, entry); // latest body of this source in the frozen cohort
    }
    if (messageIds.some(id => !selected.has(id))) return false;
    // Time can advance during asynchronous policy checks. A source that just
    // expired cannot rearm, but must not drop a fresh, independently valid WAIT.
    const eligible = messageIds.map(id => selected.get(id)!).filter(entry => (entry.item!.waitUntilMs ?? Infinity) > now);
    if (!eligible.length) return false;
    // Processor rejects sources older than five minutes. Even an unreasonable
    // configured delay must not retain a source body indefinitely.
    const deadline = now + Math.min(waitSec, 300) * 1000;
    const update = db.prepare(`UPDATE telegram_heart_candidates SET state='pending',wait_until_ms=COALESCE(wait_until_ms,?),
      attempts=0,reason='heart_wait' WHERE event_id=? AND owner=?`);
    for (const entry of eligible) update.run(deadline, entry.eventId, claim.owner);
    return true;
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
    bumpScopeVersion(scope.key, true);
    getDb().prepare('DELETE FROM telegram_heart_wait_reservations WHERE chat_key=? AND scope_key=?').run(scope.chatKey, scope.key);
    getDb().prepare("UPDATE telegram_heart_claims SET invalidated=1,cancel_reason='direct_input' WHERE scope_key=? AND owner IS NOT NULL").run(scope.key);
  });
}
