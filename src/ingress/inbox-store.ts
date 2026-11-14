import { randomUUID } from 'node:crypto';
import { getDb } from '../db/sqlite.js';
import { canonicalJson, eventHash } from '../shared/event-identity.js';
import type { MessageEventIdentity } from '../shared/event-identity.js';

export type InboxLane = 'telegram' | 'onebot' | 'qq_heart';
export type InboxState = 'pending' | 'processing' | 'handler_returned' | 'settled' | 'unknown' | 'held';
export interface InboxEntry {
  sequence: number; eventId: string; lane: InboxLane; chatId: number;
  identity: MessageEventIdentity; payload: unknown; state: InboxState;
  owner: string | null; version: number; leaseUntil: number | null;
}
export interface InboxClaim { eventId: string; owner: string; version: number }
export const INBOX_LEASE_MS = 120_000;
function durableTransaction<T>(run: () => T): T {
  const db = getDb();
  if (db.inTransaction) return db.transaction(run)();
  const previous = Number(db.pragma('synchronous', { simple: true }));
  db.pragma('synchronous = FULL');
  try { return db.transaction(run)(); }
  finally { db.pragma(`synchronous = ${previous}`); }
}
function decode(row: Record<string, unknown>): InboxEntry {
  return { sequence: Number(row['sequence']), eventId: String(row['event_id']), lane: row['lane'] as InboxLane,
    chatId: Number(row['chat_id']), identity: { ...JSON.parse(String(row['identity_json'])), processedAt: row['processed_at_ms'] ?? null },
    payload: JSON.parse(String(row['payload_json'])), state: row['state'] as InboxState,
    owner: row['owner'] as string | null, version: Number(row['version']), leaseUntil: row['lease_until_ms'] as number | null };
}
export function getInboxEntry(eventId: string): InboxEntry | null {
  const row = getDb().prepare('SELECT * FROM ingress_inbox WHERE event_id = ?').get(eventId) as Record<string, unknown> | undefined;
  return row ? decode(row) : null;
}
export function acceptInbox(input: { lane: InboxLane; chatId: number; identity: MessageEventIdentity; payload: unknown }): InboxEntry {
  const { identity, chatId, lane } = input;
  if (!Number.isSafeInteger(chatId) || !chatId || !identity.ref.conversation.accountId || !/^[a-f0-9]{64}$/.test(identity.eventId)) {
    throw new Error('invalid_inbox_identity');
  }
  const payload = canonicalJson(input.payload);
  if (Buffer.byteLength(payload) > 1024 * 1024) throw new Error('inbox_payload_too_large');
  const db = getDb();
  return durableTransaction(() => {
    db.prepare(`INSERT OR IGNORE INTO ingress_inbox
      (event_id,lane,chat_id,platform,account_id,identity_json,payload_json,payload_hash,received_at_ms,updated_at_ms)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(identity.eventId, lane, chatId, identity.ref.conversation.platform,
      identity.ref.conversation.accountId, JSON.stringify(identity), payload, eventHash(payload), identity.receivedAt, Date.now());
    const entry = getInboxEntry(identity.eventId)!;
    if (entry.chatId !== chatId || entry.lane !== lane || entry.identity.messageKey !== identity.messageKey) throw new Error('inbox_identity_collision');
    // The first accepted original is authoritative. Retransmissions may contain
    // refreshed display names/URLs; they cannot overwrite accepted source text.
    expireInboxClaims();
    return getInboxEntry(identity.eventId)!;
  });
}
/** Only never-started pending work is claimable. Expired processing is held. */
export function claimInbox(eventId: string): InboxClaim | null {
  const db = getDb(); const now = Date.now(); const owner = randomUUID();
  return durableTransaction(() => {
    expireInboxClaims(now);
    const changed = db.prepare(`UPDATE ingress_inbox SET state='processing', owner=?, version=version+1,
      processed_at_ms=COALESCE(processed_at_ms,?), lease_until_ms=?, updated_at_ms=? WHERE event_id=? AND state='pending'`)
      .run(owner, now, now + INBOX_LEASE_MS, now, eventId).changes;
    return changed ? { eventId, owner, version: getInboxEntry(eventId)!.version } : null;
  });
}
export function renewInboxClaim(claim: InboxClaim): boolean {
  const now = Date.now();
  return getDb().prepare(`UPDATE ingress_inbox SET lease_until_ms=?,updated_at_ms=?
    WHERE event_id=? AND owner=? AND version=? AND state='processing' AND lease_until_ms>?`)
    .run(now + INBOX_LEASE_MS, now, claim.eventId, claim.owner, claim.version, now).changes === 1;
}
export function settleInbox(claim: InboxClaim, state: 'handler_returned' | 'settled' | 'unknown', reason?: string): boolean {
  return getDb().prepare(`UPDATE ingress_inbox SET state=?, reason=?, updated_at_ms=?, owner=NULL,lease_until_ms=NULL
    WHERE event_id=? AND owner=? AND version=? AND state='processing' AND lease_until_ms>?`)
    .run(state, reason ?? null, Date.now(), claim.eventId, claim.owner, claim.version, Date.now()).changes === 1;
}
export function holdPendingInbox(eventId: string, reason: string): void {
  getDb().prepare("UPDATE ingress_inbox SET state='held',reason=?,updated_at_ms=? WHERE event_id=? AND state='pending'")
    .run(reason, Date.now(), eventId);
}
export function expireInboxClaims(now = Date.now()): number {
  return getDb().prepare(`UPDATE ingress_inbox SET state='unknown', reason='expired_processing', updated_at_ms=?
    WHERE state='processing' AND lease_until_ms<=?`).run(now, now).changes;
}
/** Bounded page, no total-history cutoff. Caller advances sequence across pages. */
export function listPendingInbox(lane: InboxLane, after = 0, limit = 64): InboxEntry[] {
  return (getDb().prepare(`SELECT * FROM ingress_inbox WHERE lane=? AND state='pending' AND sequence>?
    ORDER BY sequence LIMIT ?`).all(lane, after, Math.min(256, Math.max(1, limit))) as Record<string, unknown>[]).map(decode);
}
