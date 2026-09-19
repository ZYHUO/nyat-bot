// AGI-003: durable, append-only cognitive event log.
// Events carry bounded facts and explicit ownership so future reducers can
// replay a task without scraping prompt text or relying on process-local state.

import { randomUUID } from 'node:crypto';
import { getDb } from '../db/sqlite.js';
import { logger } from '../shared/logger.js';
import { env } from '../env.js';
import { scopeKey } from '../shared/cognitive-scope.js';
import type { CognitiveScope, ScopeVisibility } from '../shared/cognitive-scope.js';
import type { UpdateLike } from '../shared/types.js';

export type CognitiveEventType =
  | 'message_received'
  | 'message_edited'
  | 'user_correction'
  | 'user_goal_change'
  | 'user_stop'
  | 'task_observation'
  | 'tool_failure'
  | 'bot_delivery'
  | 'user_reaction'
  | 'user_followup'
  | 'world_change'
  | 'social_interaction'
  | 'social_act_proposed'
  | 'social_act_outcome'
  | 'inner_state_updated'
  | 'affect_episode_updated'
  | 'mission_proposed'
  | 'mission_observed'
  | 'mission_wake_requested'
  | 'sensor_proposed'
  | 'sensor_observed'
  | 'value_proposed'
  | 'value_evaluated'
  | 'value_adopted'
  | 'cognitive_process_wake'
  | 'cognitive_process_checkpoint'
  | 'cognitive_process_stopped'
  | 'action_circuit_proposed'
  | 'action_circuit_evaluated'
  | 'action_circuit_published'
  | 'capability_observed'
  | 'social_prediction'
  | 'cognitive_trigger'
  | 'cognitive_frame_observed'
  | 'action_envelope_proposed'
  | 'action_envelope_transition'
  | 'action_envelope_outcome'
  // The two event types that close the cognitive loop (NyatOS Phase 1.4).
  //
  // `own_action_result` is the bot's own act coming back with an observed
  // outcome. Without it the model cannot see what it just did — the blind spot
  // behind the documented self-reinforcing loop (heart.ts:66-76: 69 replies,
  // only 12 went through the heart).
  //
  // `self_scheduled_wake` is the bot deciding when to think next. Without it,
  // the host owns attention and the system stays a passive responder: it only
  // exists while being addressed.
  | 'own_action_result'
  | 'self_scheduled_wake'
  // The tick's own decision. unified-tick used to write nothing to this ledger at
  // all — what it chose, what its veto chain rejected, why it went quiet lived only
  // in logs. Without it there is no queryable "this is what I chose", so none of the
  // agency metrics (self-attribution, cost of preference, continuity of choice) can
  // be computed. Host-side only: zero tokens.
  | 'tick_verdict';

export type CognitiveEventSource = 'telegram' | 'host' | 'scheduler' | 'tool' | 'model' | 'import';

export interface CognitiveEvent {
  id: string;
  type: CognitiveEventType;
  scopeKey: string;
  visibility: ScopeVisibility;
  chatId: number | null;
  userId: number | null;
  taskId: string | null;
  source: CognitiveEventSource;
  occurredAt: number;
  sequence: number;
  causationId: string | null;
  correlationId: string;
  dedupeKey: string | null;
  fact: Record<string, unknown>;
  createdAt: number;
}

export interface CognitiveEventInput {
  type: CognitiveEventType;
  scope?: CognitiveScope;
  source: CognitiveEventSource;
  occurredAt?: number;
  causationId?: string;
  correlationId?: string;
  dedupeKey?: string;
  fact?: Record<string, unknown>;
}

export interface TelegramMessageEventInput {
  update: UpdateLike;
  chatId: number;
  messageId: number;
  userId?: number;
  occurredAt?: number;
}

export interface AppendCognitiveEventResult {
  inserted: boolean;
  event: CognitiveEvent;
}

export interface ListCognitiveEventsOptions {
  correlationId?: string;
  scope?: CognitiveScope;
  afterSequence?: number;
  /** Global scope replay cursor. `sequence` is only correlation-local. */
  afterOccurredAt?: number;
  afterEventId?: string;
  type?: CognitiveEventType;
  limit?: number;
  /** Use occurred-at order for bounded projections that are not replay streams. */
  order?: 'replay' | 'occurred_at' | 'occurred_at_desc';
}

export interface CognitiveOutboxItem {
  id: number;
  eventId: string;
  topic: string;
  status: 'pending' | 'processing' | 'delivered' | 'failed';
  attempts: number;
  availableAt: number;
  lockedAt: number | null;
  lockedBy: string | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
  event: CognitiveEvent | null;
}

const EVENT_TYPES: ReadonlySet<string> = new Set([
  'message_received',
  'message_edited',
  'user_correction',
  'user_goal_change',
  'user_stop',
  'task_observation',
  'tool_failure',
  'bot_delivery',
  'user_reaction',
  'user_followup',
  'world_change',
  'social_interaction',
  'social_act_proposed',
  'social_act_outcome',
  'inner_state_updated',
  'affect_episode_updated',
  'mission_proposed',
  'mission_observed',
  'mission_wake_requested',
  'sensor_proposed',
  'sensor_observed',
  'value_proposed',
  'value_evaluated',
  'value_adopted',
  'cognitive_process_wake',
  'cognitive_process_checkpoint',
  'cognitive_process_stopped',
  'action_circuit_proposed',
  'action_circuit_evaluated',
  'action_circuit_published',
  'capability_observed',
  'social_prediction',
  'cognitive_trigger',
  'cognitive_frame_observed',
  'action_envelope_proposed',
  'action_envelope_transition',
  'action_envelope_outcome',
  'own_action_result',
  'self_scheduled_wake',
]);
const EVENT_SOURCES: ReadonlySet<string> = new Set(['telegram', 'host', 'scheduler', 'tool', 'model', 'import']);
const MAX_FACT_BYTES = 8 * 1024;

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function eventsEnabled(): boolean {
  try { return env().COGNITIVE_EVENTS_ENABLED !== false; } catch { return true; }
}

function outboxEnabled(): boolean {
  try { return env().COGNITIVE_OUTBOX_ENABLED !== false; } catch { return true; }
}

function boundedId(value: string | undefined, field: string, max = 240): string | null {
  const normalized = value?.trim();
  if (!normalized) return null;
  if (normalized.length > max) throw new Error(`${field} exceeds ${max} characters`);
  return normalized;
}

function rowToEvent(row: Record<string, unknown>): CognitiveEvent {
  let fact: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(String(row['fact_json'] ?? '{}')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) fact = parsed as Record<string, unknown>;
  } catch {
    fact = {};
  }
  return {
    id: String(row['id']),
    type: row['type'] as CognitiveEventType,
    scopeKey: String(row['scope_key']),
    visibility: row['visibility'] as ScopeVisibility,
    chatId: row['chat_id'] === null ? null : Number(row['chat_id']),
    userId: row['user_id'] === null ? null : Number(row['user_id']),
    taskId: row['task_id'] === null ? null : String(row['task_id']),
    source: row['source'] as CognitiveEventSource,
    occurredAt: Number(row['occurred_at']),
    sequence: Number(row['sequence']),
    causationId: row['causation_id'] === null ? null : String(row['causation_id']),
    correlationId: String(row['correlation_id']),
    dedupeKey: row['dedupe_key'] === null ? null : String(row['dedupe_key']),
    fact,
    createdAt: Number(row['created_at']),
  };
}

function rowToOutbox(row: Record<string, unknown>, event?: CognitiveEvent | null): CognitiveOutboxItem {
  return {
    id: Number(row['id']),
    eventId: String(row['event_id']),
    topic: String(row['topic']),
    status: row['status'] as CognitiveOutboxItem['status'],
    attempts: Number(row['attempts']),
    availableAt: Number(row['available_at']),
    lockedAt: row['locked_at'] === null ? null : Number(row['locked_at']),
    lockedBy: row['locked_by'] === null ? null : String(row['locked_by']),
    lastError: row['last_error'] === null ? null : String(row['last_error']),
    createdAt: Number(row['created_at']),
    updatedAt: Number(row['updated_at']),
    event: event === undefined ? null : event,
  };
}

function hasOutboxTable(db: ReturnType<typeof getDb>): boolean {
  const statement = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'cognitive_outbox'") as { get?: () => unknown };
  return typeof statement.get === 'function' && Boolean(statement.get());
}

function hasEventsTable(db: ReturnType<typeof getDb>): boolean {
  const statement = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'cognitive_events'") as { get?: () => unknown };
  return typeof statement.get === 'function' && Boolean(statement.get());
}

function normalizeInput(input: CognitiveEventInput): {
  key: string;
  visibility: ScopeVisibility;
  chatId: number | null;
  userId: number | null;
  taskId: string | null;
  occurredAt: number;
  causationId: string | null;
  correlationId: string;
  dedupeKey: string | null;
  factJson: string;
} {
  if (!EVENT_TYPES.has(input.type)) throw new Error(`unknown cognitive event type: ${String(input.type)}`);
  if (!EVENT_SOURCES.has(input.source)) throw new Error(`unknown cognitive event source: ${String(input.source)}`);
  const scope = input.scope ?? { visibility: 'global' as const };
  const key = scopeKey(scope);
  for (const [name, value] of [['chatId', scope.chatId], ['userId', scope.userId]] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value === 0)) throw new Error(`${name} must be a non-zero safe integer`);
  }
  const occurredAt = input.occurredAt ?? nowSec();
  if (!Number.isSafeInteger(occurredAt) || occurredAt <= 0) throw new Error('occurredAt must be a positive integer in seconds');
  const correlationId = boundedId(input.correlationId, 'correlationId') ?? `event-stream:${key}`;
  let factJson: string;
  try {
    factJson = JSON.stringify(input.fact ?? {});
  } catch {
    throw new Error('fact must be JSON serializable');
  }
  if (typeof factJson !== 'string') throw new Error('fact must be a JSON object');
  if (Buffer.byteLength(factJson, 'utf8') > MAX_FACT_BYTES) throw new Error(`fact exceeds ${MAX_FACT_BYTES} bytes`);
  return {
    key,
    visibility: scope.visibility,
    chatId: scope.chatId ?? null,
    userId: scope.userId ?? null,
    taskId: scope.taskId?.trim().slice(0, 120) ?? null,
    occurredAt,
    causationId: boundedId(input.causationId, 'causationId'),
    correlationId,
    dedupeKey: boundedId(input.dedupeKey, 'dedupeKey'),
    factJson,
  };
}

/** Append one event. A duplicate dedupe key returns the original event. */
export function appendCognitiveEvent(input: CognitiveEventInput): AppendCognitiveEventResult | null {
  if (!eventsEnabled()) return null;
  const normalized = normalizeInput(input);
  const db = getDb();
  const createdAt = nowSec();
  try {
    if (!hasEventsTable(db)) return null;
    return db.transaction(() => {
      if (normalized.dedupeKey) {
        const duplicate = db.prepare('SELECT * FROM cognitive_events WHERE dedupe_key = ?').get(normalized.dedupeKey) as Record<string, unknown> | undefined;
        if (duplicate) return { inserted: false, event: rowToEvent(duplicate) };
      }
      const next = db
        .prepare('SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM cognitive_events WHERE correlation_id = ?')
        .get(normalized.correlationId) as { next: number };
      const id = randomUUID();
      db.prepare(
        `INSERT INTO cognitive_events
           (id, type, scope_key, visibility, chat_id, user_id, task_id, source,
            occurred_at, sequence, causation_id, correlation_id, dedupe_key, fact_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.type,
        normalized.key,
        normalized.visibility,
        normalized.chatId,
        normalized.userId,
        normalized.taskId,
        input.source,
        normalized.occurredAt,
        next.next,
        normalized.causationId,
        normalized.correlationId,
        normalized.dedupeKey,
        normalized.factJson,
        createdAt,
      );
      if (outboxEnabled() && hasOutboxTable(db)) {
        db.prepare(
          `INSERT INTO cognitive_outbox (event_id, topic, status, attempts, available_at, created_at, updated_at)
           VALUES (?, 'cognitive.event', 'pending', 0, ?, ?, ?)`,
        ).run(id, createdAt, createdAt, createdAt);
      }
      const row = db.prepare('SELECT * FROM cognitive_events WHERE id = ?').get(id) as Record<string, unknown>;
      return { inserted: true, event: rowToEvent(row) };
    })();
  } catch (err) {
    logger.warn({ err, type: input.type, source: input.source }, 'cognitive event append failed');
    return null;
  }
}

/** Append the canonical metadata-only event for one Telegram message/update. */
export function appendTelegramMessageEvent(input: TelegramMessageEventInput): string | undefined {
  try {
    const raw = input.update as Record<string, unknown>;
    const isEdit = Boolean(raw['edited_message'] || raw['edited_channel_post']);
    const telegramMessage = (raw['edited_message'] ?? raw['edited_channel_post'] ?? raw['message'] ?? raw['channel_post']) as Record<string, unknown> | undefined;
    const updateId = typeof raw['update_id'] === 'number' ? raw['update_id'] : undefined;
    const telegramKey = updateId === undefined ? `${input.chatId}:${input.messageId}` : String(updateId);
    const versionKey = isEdit ? String(telegramMessage?.['edit_date'] ?? telegramKey) : telegramKey;
    const result = appendCognitiveEvent({
      type: isEdit ? 'message_edited' : 'message_received',
      scope: {
        visibility: 'chat',
        chatId: input.chatId,
        ...(input.userId !== undefined && input.userId > 0 ? { userId: input.userId } : {}),
      },
      source: 'telegram',
      occurredAt: input.occurredAt,
      correlationId: `telegram:${input.chatId}:${telegramKey}`,
      dedupeKey: `telegram:${input.chatId}:${input.messageId}:${isEdit ? `edit:${versionKey}` : `message:${versionKey}`}`,
      fact: {
        chatId: input.chatId,
        messageId: input.messageId,
        userId: input.userId ?? null,
        updateId: updateId ?? null,
        isEdit,
      },
    });
    return result?.event.id;
  } catch (err) {
    logger.debug({ err, chatId: input.chatId, messageId: input.messageId }, 'telegram cognitive event helper failed');
    return undefined;
  }
}

/** Return pending work, including leases that expired after a worker crash. */
export function claimCognitiveOutbox(workerId: string, limit = 50, leaseSec = 60): CognitiveOutboxItem[] {
  const worker = workerId.trim().slice(0, 120);
  if (!worker) return [];
  const now = nowSec();
  const take = Math.min(Math.max(Math.trunc(limit), 1), 200);
  try {
    const db = getDb();
    if (!hasOutboxTable(db)) return [];
    return db.transaction(() => {
      const rows = db
        .prepare(
          `SELECT o.*, e.type, e.scope_key, e.visibility, e.chat_id, e.user_id, e.task_id,
                  e.source, e.occurred_at, e.sequence, e.causation_id, e.correlation_id,
                  e.dedupe_key, e.fact_json, e.created_at AS event_created_at
           FROM cognitive_outbox o JOIN cognitive_events e ON e.id = o.event_id
           WHERE (o.status = 'pending' AND o.available_at <= ?)
              OR (o.status = 'processing' AND o.locked_at IS NOT NULL AND o.locked_at <= ?)
           ORDER BY o.id ASC LIMIT ?`,
        )
        .all(now, now - Math.max(1, leaseSec), take) as Array<Record<string, unknown>>;
      const update = db.prepare(
        `UPDATE cognitive_outbox SET status = 'processing', attempts = attempts + 1,
           locked_at = ?, locked_by = ?, updated_at = ? WHERE id = ?`,
      );
      const out: CognitiveOutboxItem[] = [];
      for (const row of rows) {
        update.run(now, worker, now, row['id']);
        const event = rowToEvent({
          id: row['event_id'], type: row['type'], scope_key: row['scope_key'], visibility: row['visibility'],
          chat_id: row['chat_id'], user_id: row['user_id'], task_id: row['task_id'], source: row['source'],
          occurred_at: row['occurred_at'], sequence: row['sequence'], causation_id: row['causation_id'],
          correlation_id: row['correlation_id'], dedupe_key: row['dedupe_key'], fact_json: row['fact_json'],
          created_at: row['event_created_at'],
        });
        out.push(rowToOutbox({ ...row, status: 'processing', attempts: Number(row['attempts']) + 1, locked_at: now, locked_by: worker, updated_at: now }, event));
      }
      return out;
    })();
  } catch (err) {
    logger.warn({ err, worker }, 'cognitive outbox claim failed');
    return [];
  }
}

export function ackCognitiveOutbox(id: number, workerId?: string): boolean {
  try {
    const db = getDb();
    const where = workerId?.trim() ? `id = ? AND status = 'processing' AND locked_by = ?` : `id = ? AND status = 'processing'`;
    const params = workerId?.trim() ? [id, workerId.trim()] : [id];
    const result = db.prepare(`UPDATE cognitive_outbox SET status = 'delivered', locked_at = NULL, locked_by = NULL, updated_at = ? WHERE ${where}`).run(nowSec(), ...params);
    return result.changes === 1;
  } catch (err) {
    logger.warn({ err, id }, 'cognitive outbox ack failed');
    return false;
  }
}

export function failCognitiveOutbox(id: number, error: string, retryInSec = 30, workerId?: string): boolean {
  try {
    const db = getDb();
    const now = nowSec();
    const where = workerId?.trim() ? `id = ? AND status = 'processing' AND locked_by = ?` : `id = ? AND status = 'processing'`;
    const params = workerId?.trim() ? [id, workerId.trim()] : [id];
    const current = db.prepare(`SELECT attempts FROM cognitive_outbox WHERE ${where}`).get(...params) as { attempts: number } | undefined;
    if (!current) return false;
    const retry = Math.max(0, Math.trunc(retryInSec));
    const status = retry > 0 ? 'pending' : 'failed';
    const result = db.prepare(
      `UPDATE cognitive_outbox SET status = ?, available_at = ?, locked_at = NULL, locked_by = NULL,
         last_error = ?, updated_at = ? WHERE ${where}`,
    ).run(status, now + retry, error.trim().slice(0, 500), now, ...params);
    return result.changes === 1;
  } catch (err) {
    logger.warn({ err, id }, 'cognitive outbox failure update failed');
    return false;
  }
}

export function listCognitiveOutbox(status?: CognitiveOutboxItem['status'], limit = 100): CognitiveOutboxItem[] {
  try {
    const db = getDb();
    if (!hasOutboxTable(db)) return [];
    const take = Math.min(Math.max(Math.trunc(limit), 1), 500);
    const rows = status
      ? db.prepare('SELECT * FROM cognitive_outbox WHERE status = ? ORDER BY id ASC LIMIT ?').all(status, take) as Record<string, unknown>[]
      : db.prepare('SELECT * FROM cognitive_outbox ORDER BY id ASC LIMIT ?').all(take) as Record<string, unknown>[];
    return rows.map((row) => {
      const eventRow = db.prepare('SELECT * FROM cognitive_events WHERE id = ?').get(row['event_id']) as Record<string, unknown> | undefined;
      return rowToOutbox(row, eventRow ? rowToEvent(eventRow) : null);
    });
  } catch (err) {
    logger.debug({ err }, 'cognitive outbox list failed');
    return [];
  }
}

export function getCognitiveEvent(id: string): CognitiveEvent | null {
  try {
    const row = getDb().prepare('SELECT * FROM cognitive_events WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? rowToEvent(row) : null;
  } catch {
    return null;
  }
}

/** Return the newest Telegram message/edit event for a chat, if available. */
export function getLatestTelegramMessageEventId(chatId: number): string | undefined {
  if (!Number.isSafeInteger(chatId) || chatId === 0) return undefined;
  const events = listCognitiveEvents({
    scope: { visibility: 'chat', chatId },
    order: 'occurred_at_desc',
    limit: 100,
  });
  return events.find((event) => event.source === 'telegram'
    && (event.type === 'message_received' || event.type === 'message_edited'))?.id;
}

/** List in replay order. A supplied scope is an exact scope filter. */
export function listCognitiveEvents(opts: ListCognitiveEventsOptions = {}): CognitiveEvent[] {
  try {
    const db = getDb();
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.correlationId) {
      where.push('correlation_id = ?');
      params.push(opts.correlationId);
    }
    if (opts.scope) {
      where.push('scope_key = ?');
      params.push(scopeKey(opts.scope));
    }
    if (opts.afterSequence !== undefined) {
      where.push('sequence > ?');
      params.push(opts.afterSequence);
    }
    if (opts.afterOccurredAt !== undefined) {
      const afterEventId = opts.afterEventId?.trim();
      if (afterEventId) {
        where.push('(occurred_at > ? OR (occurred_at = ? AND id > ?))');
        params.push(opts.afterOccurredAt, opts.afterOccurredAt, afterEventId);
      } else {
        where.push('occurred_at > ?');
        params.push(opts.afterOccurredAt);
      }
    }
    if (opts.type) {
      where.push('type = ?');
      params.push(opts.type);
    }
    const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 200), 1), 1000);
    const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const order = opts.order === 'occurred_at_desc'
      ? 'occurred_at DESC, id DESC'
      : opts.order === 'occurred_at'
        ? 'occurred_at ASC, id ASC'
      : 'correlation_id ASC, sequence ASC';
    const rows = db.prepare(`SELECT * FROM cognitive_events ${filter} ORDER BY ${order} LIMIT ?`).all(...params, limit) as Record<string, unknown>[];
    return rows.map(rowToEvent);
  } catch (err) {
    logger.debug({ err }, 'cognitive event list failed');
    return [];
  }
}

/** Replay one causal stream in sequence order. */
export async function replayCognitiveEvents(
  correlationId: string,
  handler: (event: CognitiveEvent) => void | Promise<void>,
): Promise<number> {
  const events = listCognitiveEvents({ correlationId, limit: 1000 });
  for (const event of events) await handler(event);
  return events.length;
}
