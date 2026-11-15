// Restart-safe cursor for scope-local event projections.
//
// The event sequence is scoped to a correlation, not to a chat, so a cursor
// stores the ordered `(occurred_at,event_id)` position instead. Lease changes
// use conditional SQLite updates and therefore remain safe across workers.

import { getDb } from '../db/sqlite.js';
import { logger } from '../shared/logger.js';
import { scopeKey, type CognitiveScope } from '../shared/cognitive-scope.js';
import { listCognitiveEvents, type CognitiveEvent } from './cognitive-events.js';

export interface CognitiveCursor {
  scope: CognitiveScope;
  scopeKey: string;
  stream: string;
  occurredAt: number;
  eventId: string | null;
  leaseOwner: string | null;
  leaseUntil: number | null;
  updatedAt: number;
}

export interface CognitiveCursorPosition {
  occurredAt: number;
  eventId: string;
}

export interface CognitiveCursorClaim extends CognitiveCursor {
  claimed: boolean;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function validName(value: string, max = 160): boolean {
  return value.trim().length > 0 && value.trim().length <= max;
}

function rowToCursor(row: Record<string, unknown>, scope: CognitiveScope, key: string): CognitiveCursor {
  return {
    scope,
    scopeKey: key,
    stream: String(row['stream']),
    occurredAt: Number(row['occurred_at'] ?? 0),
    eventId: row['event_id'] === null ? null : String(row['event_id']),
    leaseOwner: row['lease_owner'] === null ? null : String(row['lease_owner']),
    leaseUntil: row['lease_until'] === null ? null : Number(row['lease_until']),
    updatedAt: Number(row['updated_at'] ?? 0),
  };
}

function tableAvailable(): boolean {
  try {
    const db = getDb();
    return Boolean((db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='cognitive_cursors'").get() as unknown));
  } catch {
    return false;
  }
}

function normalize(input: { scope: CognitiveScope; stream: string; owner?: string }): { scope: CognitiveScope; key: string; stream: string; owner?: string } | null {
  if (!validName(input.stream) || (input.owner !== undefined && !validName(input.owner, 120))) return null;
  try {
    return {
      scope: input.scope,
      key: scopeKey(input.scope),
      stream: input.stream.trim().slice(0, 160),
      ...(input.owner === undefined ? {} : { owner: input.owner.trim().slice(0, 120) }),
    };
  } catch {
    return null;
  }
}

/** Read a cursor without acquiring its lease. */
export function getCognitiveCursor(input: { scope: CognitiveScope; stream: string }): CognitiveCursor | null {
  const normalized = normalize(input);
  if (!normalized || !tableAvailable()) return null;
  try {
    const row = getDb().prepare(
      'SELECT * FROM cognitive_cursors WHERE scope_key = ? AND stream = ?',
    ).get(normalized.key, normalized.stream) as Record<string, unknown> | undefined;
    return row ? rowToCursor(row, normalized.scope, normalized.key) : null;
  } catch (err) {
    logger.debug({ err, stream: normalized.stream }, 'cognitive cursor read failed');
    return null;
  }
}

/** Claim or renew a cursor lease. A live lease owned by another worker wins. */
export function claimCognitiveCursor(input: {
  scope: CognitiveScope;
  stream: string;
  owner: string;
  leaseSec?: number;
  nowSec?: number;
}): CognitiveCursorClaim | null {
  const normalized = normalize(input);
  if (!normalized || !normalized.owner || !tableAvailable()) return null;
  const now = Number.isSafeInteger(input.nowSec) && (input.nowSec ?? 0) > 0 ? Number(input.nowSec) : nowSec();
  const leaseUntil = now + Math.min(86_400, Math.max(5, Math.trunc(input.leaseSec ?? 60)));
  try {
    const db = getDb();
    return db.transaction(() => {
      const existing = db.prepare(
        'SELECT * FROM cognitive_cursors WHERE scope_key = ? AND stream = ?',
      ).get(normalized.key, normalized.stream) as Record<string, unknown> | undefined;
      const existingOwner = existing?.['lease_owner'] === null || existing?.['lease_owner'] === undefined
        ? null
        : String(existing['lease_owner']);
      const existingLease = existing?.['lease_until'] === null || existing?.['lease_until'] === undefined
        ? null
        : Number(existing['lease_until']);
      if (existing && existingOwner && existingOwner !== normalized.owner && existingLease !== null && existingLease > now) {
        return { ...rowToCursor(existing, normalized.scope, normalized.key), claimed: false };
      }
      if (!existing) {
        db.prepare(
          `INSERT INTO cognitive_cursors
            (scope_key, stream, occurred_at, event_id, lease_owner, lease_until, updated_at)
           VALUES (?, ?, 0, NULL, ?, ?, ?)`,
        ).run(normalized.key, normalized.stream, normalized.owner, leaseUntil, now);
      } else {
        db.prepare(
          `UPDATE cognitive_cursors SET lease_owner = ?, lease_until = ?, updated_at = ?
           WHERE scope_key = ? AND stream = ?`,
        ).run(normalized.owner, leaseUntil, now, normalized.key, normalized.stream);
      }
      const row = db.prepare(
        'SELECT * FROM cognitive_cursors WHERE scope_key = ? AND stream = ?',
      ).get(normalized.key, normalized.stream) as Record<string, unknown>;
      return { ...rowToCursor(row, normalized.scope, normalized.key), claimed: true };
    })();
  } catch (err) {
    logger.debug({ err, stream: normalized.stream }, 'cognitive cursor claim failed');
    return null;
  }
}

/** Advance only a lease owned by the caller and never move backwards. */
export function advanceCognitiveCursor(input: {
  scope: CognitiveScope;
  stream: string;
  owner: string;
  position: CognitiveCursorPosition;
  nowSec?: number;
  release?: boolean;
}): boolean {
  const normalized = normalize(input);
  const position = input.position;
  if (!normalized || !normalized.owner || !validName(position.eventId, 240)
    || !Number.isSafeInteger(position.occurredAt) || position.occurredAt < 0 || !tableAvailable()) return false;
  const now = Number.isSafeInteger(input.nowSec) && (input.nowSec ?? 0) > 0 ? Number(input.nowSec) : nowSec();
  try {
    const result = getDb().prepare(
      `UPDATE cognitive_cursors
       SET occurred_at = ?, event_id = ?, updated_at = ?,
           lease_owner = CASE WHEN ? = 1 THEN NULL ELSE lease_owner END,
           lease_until = CASE WHEN ? = 1 THEN NULL ELSE lease_until END
       WHERE scope_key = ? AND stream = ? AND lease_owner = ?
         AND (occurred_at < ? OR (occurred_at = ? AND (event_id IS NULL OR event_id < ?)))`,
    ).run(
      position.occurredAt,
      position.eventId.trim().slice(0, 240),
      now,
      input.release === true ? 1 : 0,
      input.release === true ? 1 : 0,
      normalized.key,
      normalized.stream,
      normalized.owner,
      position.occurredAt,
      position.occurredAt,
      position.eventId,
    ) as { changes?: number };
    return result.changes === 1;
  } catch (err) {
    logger.debug({ err, stream: normalized.stream }, 'cognitive cursor advance failed');
    return false;
  }
}

/** Release a lease without changing the position. */
export function releaseCognitiveCursor(input: { scope: CognitiveScope; stream: string; owner: string }): boolean {
  const normalized = normalize(input);
  if (!normalized || !normalized.owner || !tableAvailable()) return false;
  try {
    const result = getDb().prepare(
      `UPDATE cognitive_cursors SET lease_owner = NULL, lease_until = NULL, updated_at = ?
       WHERE scope_key = ? AND stream = ? AND lease_owner = ?`,
    ).run(nowSec(), normalized.key, normalized.stream, normalized.owner) as { changes?: number };
    return result.changes === 1;
  } catch (err) {
    logger.debug({ err, stream: normalized.stream }, 'cognitive cursor release failed');
    return false;
  }
}

/** Read a bounded batch after the cursor's global `(occurred_at,event_id)` position. */
export function listCognitiveEventsAfterCursor(input: {
  scope: CognitiveScope;
  stream: string;
  limit?: number;
}): CognitiveEvent[] {
  const cursor = getCognitiveCursor(input);
  const limit = Math.min(1000, Math.max(1, Math.trunc(input.limit ?? 100)));
  return listCognitiveEvents({
    scope: input.scope,
    order: 'occurred_at',
    limit,
    ...(cursor && cursor.eventId !== null
      ? { afterOccurredAt: cursor.occurredAt, afterEventId: cursor.eventId }
      : {}),
  });
}

