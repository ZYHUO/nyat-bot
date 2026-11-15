// The cognitive clock: the model's own record of what it did and when it wants
// to think again.
//
// WHY THIS EXISTS (NyatOS Phase 1.4)
//
// Two things were missing that made the loop open instead of closed:
//
//   1. `own_action_result` — the bot's own act returning with an observed
//      outcome. Without it the model cannot see what it just did. That blind
//      spot caused a real incident documented in src/pipeline/heart/heart.ts:66-76:
//      "bot 说一句 → 后续消息命中跟进规则 → 自动回 → 永远'刚说过话'
//       → 69 次回复里只有 12 次经过心流".
//
//   2. `self_scheduled_wake` — the bot deciding when to think next. Without it
//      the host owns attention, and the system stays a passive responder that
//      only exists while being addressed.
//
// This module only records and reads. It never decides anything, never sends,
// and never calls a model. Callers (the delivery stage, the heart decision) ask
// it what happened and when to wake; the judgement stays theirs.

import { appendCognitiveEvent, listCognitiveEvents, type CognitiveEvent } from './cognitive-events.js';
import { logger } from '../shared/logger.js';
import { scopeKey, type CognitiveScope } from '../shared/cognitive-scope.js';

/** How an act landed, as observed by the host. Mirrors tracking/self-history. */
export type ActOutcome =
  | 'ignored'
  | 'replied'
  | 'reacted'
  | 'mentioned'
  | 'corrected'
  | 'unknown';

export interface OwnActionResult {
  eventId: string;
  at: number;
  chatId: number;
  botMessageId: number;
  outcome: ActOutcome;
  preview?: string;
}

export interface ScheduledWake {
  eventId: string;
  scope: CognitiveScope;
  wakeAt: number;
  about?: string;
  /** Event that caused this wake (usually the act that decided to come back). */
  causeEventId?: string;
}

const MAX_PREVIEW = 60;
const MAX_ABOUT = 120;
const MIN_WAKE_DELAY_SEC = 30;
const MAX_WAKE_DELAY_SEC = 7 * 86400;
const DEFAULT_LIST_LIMIT = 50;

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/** Strip newlines/control chars so a value cannot forge extra prompt lines. */
function inline(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/[\r\n]+/g, ' ').replace(/[\x00-\x1f\x7f]/g, '').trim();
  return text ? text.slice(0, max) : undefined;
}

function validScope(scope: CognitiveScope): boolean {
  try {
    scopeKey(scope);
    return true;
  } catch {
    return false;
  }
}

function actOutcome(value: unknown): ActOutcome {
  switch (value) {
    case 'ignored':
    case 'replied':
    case 'reacted':
    case 'mentioned':
    case 'corrected':
      return value;
    default:
      return 'unknown';
  }
}

/**
 * Record that one of the bot's own acts came back with an observed outcome.
 *
 * Idempotent per (chat, message, outcome): the delivery path and the outcome
 * tracker can both call this for the same act without creating duplicates.
 */
export function recordOwnActionResult(input: {
  scope: CognitiveScope;
  botMessageId: number;
  outcome: ActOutcome;
  preview?: string;
  occurredAt?: number;
}): { inserted: boolean; eventId: string } | null {
  if (!validScope(input.scope)) return null;
  const chatId = input.scope.chatId;
  if (chatId === undefined || !Number.isSafeInteger(chatId) || chatId === 0) return null;
  if (!Number.isSafeInteger(input.botMessageId) || input.botMessageId <= 0) return null;
  const outcome = actOutcome(input.outcome);
  const occurredAt = Number.isSafeInteger(input.occurredAt) && (input.occurredAt ?? 0) > 0
    ? Number(input.occurredAt)
    : nowSec();
  const result = appendCognitiveEvent({
    type: 'own_action_result',
    source: 'host',
    scope: input.scope,
    occurredAt,
    correlationId: `own-act:${scopeKey(input.scope)}:${input.botMessageId}`,
    dedupeKey: `own-action-result:${scopeKey(input.scope)}:${input.botMessageId}:${outcome}`,
    fact: {
      schema: 'own_action_result.v1',
      botMessageId: input.botMessageId,
      outcome,
      ...(inline(input.preview, MAX_PREVIEW) ? { preview: inline(input.preview, MAX_PREVIEW) } : {}),
    },
  });
  return result ? { inserted: result.inserted, eventId: result.event.id } : null;
}

/**
 * Record that the bot wants to think about something again at a future time.
 *
 * The delay is clamped to a sane window: a model asking to wake in 2 seconds
 * would spin, and one asking for a year would effectively stop existing. The
 * clamp is a reality bound (like a message length cap), not a behavioural rule.
 */
export function scheduleSelfWake(input: {
  scope: CognitiveScope;
  wakeAt?: number;
  delaySec?: number;
  about?: string;
  causeEventId?: string;
  now?: number;
}): { inserted: boolean; eventId: string; wakeAt: number } | null {
  if (!validScope(input.scope)) return null;
  const now = Number.isSafeInteger(input.now) && (input.now ?? 0) > 0 ? Number(input.now) : nowSec();
  let wakeAt: number;
  if (Number.isSafeInteger(input.wakeAt) && (input.wakeAt ?? 0) > 0) {
    wakeAt = Number(input.wakeAt);
  } else if (Number.isFinite(input.delaySec)) {
    wakeAt = now + Math.trunc(Number(input.delaySec));
  } else {
    return null;
  }
  wakeAt = Math.min(now + MAX_WAKE_DELAY_SEC, Math.max(now + MIN_WAKE_DELAY_SEC, wakeAt));
  const about = inline(input.about, MAX_ABOUT);
  const result = appendCognitiveEvent({
    type: 'self_scheduled_wake',
    source: 'host',
    scope: input.scope,
    occurredAt: now,
    ...(input.causeEventId ? { causationId: input.causeEventId } : {}),
    correlationId: `self-wake:${scopeKey(input.scope)}`,
    dedupeKey: `self-wake:${scopeKey(input.scope)}:${wakeAt}`,
    fact: {
      schema: 'self_scheduled_wake.v1',
      wakeAt,
      ...(about ? { about } : {}),
    },
  });
  return result ? { inserted: result.inserted, eventId: result.event.id, wakeAt } : null;
}

/** Read recent act results for one scope, newest first. */
export function listOwnActionResults(
  scope: CognitiveScope,
  limit = DEFAULT_LIST_LIMIT,
): OwnActionResult[] {
  if (!validScope(scope)) return [];
  const chatId = scope.chatId;
  if (chatId === undefined) return [];
  const events = listCognitiveEvents({
    scope,
    type: 'own_action_result',
    order: 'occurred_at_desc',
    limit: Math.min(200, Math.max(1, Math.trunc(limit))),
  });
  const out: OwnActionResult[] = [];
  for (const event of events) {
    const botMessageId = event.fact['botMessageId'];
    if (typeof botMessageId !== 'number' || !Number.isSafeInteger(botMessageId)) continue;
    const preview = inline(event.fact['preview'], MAX_PREVIEW);
    out.push({
      eventId: event.id,
      at: event.occurredAt,
      chatId,
      botMessageId,
      outcome: actOutcome(event.fact['outcome']),
      ...(preview ? { preview } : {}),
    });
  }
  return out;
}

/**
 * Self-scheduled wakes that are due now and have not been superseded.
 *
 * A wake is considered consumed once a later self-scheduled wake exists for the
 * same scope, so the model re-scheduling naturally retires the old one instead
 * of accumulating a backlog it must explicitly drain.
 */
export function listDueSelfWakes(
  scope: CognitiveScope,
  now = nowSec(),
  limit = 10,
): ScheduledWake[] {
  if (!validScope(scope)) return [];
  const events = listCognitiveEvents({
    scope,
    type: 'self_scheduled_wake',
    order: 'occurred_at_desc',
    limit: 200,
  });
  const out: ScheduledWake[] = [];
  const seen = new Set<number>();
  for (const event of events) {
    const wakeAt = event.fact['wakeAt'];
    if (typeof wakeAt !== 'number' || !Number.isSafeInteger(wakeAt)) continue;
    if (wakeAt > now) continue;
    if (seen.has(wakeAt)) continue;
    seen.add(wakeAt);
    const about = inline(event.fact['about'], MAX_ABOUT);
    out.push({
      eventId: event.id,
      scope,
      wakeAt,
      ...(about ? { about } : {}),
      ...(event.causationId ? { causeEventId: event.causationId } : {}),
    });
    if (out.length >= Math.min(50, Math.max(1, Math.trunc(limit)))) break;
  }
  return out;
}

/** The next pending wake for a scope, if any (for prompt rendering). */
export function nextSelfWake(
  scope: CognitiveScope,
  now = nowSec(),
): ScheduledWake | null {
  if (!validScope(scope)) return null;
  const events = listCognitiveEvents({
    scope,
    type: 'self_scheduled_wake',
    order: 'occurred_at_desc',
    limit: 50,
  });
  for (const event of events) {
    const wakeAt = event.fact['wakeAt'];
    if (typeof wakeAt !== 'number' || !Number.isSafeInteger(wakeAt)) continue;
    if (wakeAt <= now) continue;
    const about = inline(event.fact['about'], MAX_ABOUT);
    return {
      eventId: event.id,
      scope,
      wakeAt,
      ...(about ? { about } : {}),
      ...(event.causationId ? { causeEventId: event.causationId } : {}),
    };
  }
  return null;
}

/**
 * Render the bot's pending wake as a compact fact line.
 *
 * Deliberately separate from "what I did": that fact lives in `self_replies`
 * (complete, including acts with no outcome yet), while the scheduled wake only
 * exists in this ledger. Each fact is rendered from its canonical source rather
 * than duplicated into a second store.
 */
export function renderPendingWake(
  pendingWake: ScheduledWake | null,
  now = nowSec(),
): string {
  if (!pendingWake) return '';
  const mins = Math.max(1, Math.round((pendingWake.wakeAt - now) / 60));
  return `[你自己定的下一次] ${mins} 分钟后你打算再想想${pendingWake.about ? `「${pendingWake.about}」` : ''}。`;
}

/** True when a persisted event is one of the loop-closing kinds. */
export function isLoopEvent(event: CognitiveEvent): boolean {
  return event.type === 'own_action_result' || event.type === 'self_scheduled_wake';
}

/** Fail-soft wrapper for callers on the message path. */
export function safeRecordOwnActionResult(input: Parameters<typeof recordOwnActionResult>[0]): void {
  try {
    recordOwnActionResult(input);
  } catch (err) {
    logger.debug({ err }, 'cognitive-clock: own action result failed (non-critical)');
  }
}
