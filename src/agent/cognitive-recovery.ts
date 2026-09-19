// Host-owned recovery for kernel actions left open by a crash.
//
// A turn that reached `dispatched` and then lost its process has no terminal
// outcome. Recovery never re-sends: re-dispatching after an unknown Telegram
// receipt is exactly the duplicate-side-effect failure the kernel budget is
// meant to prevent. Instead the host closes the action as `interrupted` with a
// receipt that records who closed it and why, so replay sees a real terminus.
//
// Each scope is swept under a durable cursor lease, and the cursor never
// advances past an action that is still open and inside its host budget.

import { randomUUID } from 'node:crypto';
import { logger } from '../shared/logger.js';
import {
  advanceCognitiveCursor,
  claimCognitiveCursor,
  releaseCognitiveCursor,
} from './cognitive-cursor.js';
import { listCognitiveEvents, type CognitiveEvent } from './cognitive-events.js';
import {
  recordKernelActionOutcome,
  scopeFromCognitiveEvent,
} from './cognitive-kernel.js';
import { env } from '../env.js';
import { scopeKey, type CognitiveScope } from '../shared/cognitive-scope.js';

export const KERNEL_RECOVERY_STREAM = 'kernel:recovery';

/** Grace for envelopes whose proposal text could not be read back. */
const FALLBACK_WALL_CLOCK_SEC = 3600;
const DEFAULT_LOOKBACK_SEC = 7 * 86400;
const MAX_SCOPES_PER_SWEEP = 25;
const MAX_EVENTS_PER_SCOPE = 500;
const MAX_SETTLEMENTS_PER_SWEEP = 50;

interface StaleAction {
  envelopeId: string;
  dispatchedAt: number;
  expandedDeadline: number;
  dispatchEventId: string;
}

export interface RecoveredAction {
  scopeKey: string;
  envelopeId: string;
  dispatchedAt: number;
  closedAt: number;
  reason: string;
}

export interface CognitiveRecoveryResult {
  scopesScanned: number;
  scopesSkipped: number;
  openActions: number;
  recovered: number;
  actions: RecoveredAction[];
}

export interface CognitiveRecoveryOptions {
  now?: number;
  lookbackSec?: number;
  owner?: string;
  leaseSec?: number;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function recoveryEnabled(): boolean {
  try {
    return env().COGNITIVE_KERNEL_RECOVERY_ENABLED === true;
  } catch {
    return false;
  }
}

function envelopeIdOf(event: CognitiveEvent): string | undefined {
  const raw = event.fact['envelopeId'];
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim();
  return value ? value : undefined;
}

function statusOf(event: CognitiveEvent): string | undefined {
  const raw = event.fact['status'];
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim();
  return value ? value : undefined;
}

/**
 * Host budget of a proposed envelope. A missing or malformed proposal falls
 * back to a short grace so an unreadable dispatch still reaches a terminus.
 */
function wallClockSec(envelope: unknown): number {
  if (!envelope || typeof envelope !== 'object') return FALLBACK_WALL_CLOCK_SEC;
  const budget = (envelope as { budget?: unknown }).budget;
  if (!budget || typeof budget !== 'object') return FALLBACK_WALL_CLOCK_SEC;
  const value = (budget as { maxWallClockSec?: unknown }).maxWallClockSec;
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? Math.min(value, 7 * 86400)
    : FALLBACK_WALL_CLOCK_SEC;
}

function createdAtOf(envelope: unknown): number | undefined {
  if (!envelope || typeof envelope !== 'object') return undefined;
  const value = (envelope as { createdAt?: unknown }).createdAt;
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

/** Scopes that recently dispatched an action, most recent first. */
function candidateScopes(since: number, limit: number): CognitiveScope[] {
  const events = listCognitiveEvents({
    type: 'action_envelope_transition',
    order: 'occurred_at_desc',
    afterOccurredAt: since,
    limit,
  });
  const scopes: CognitiveScope[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    if (statusOf(event) !== 'dispatched') continue;
    const scope = scopeFromCognitiveEvent(event);
    let key: string;
    try {
      key = scopeKey(scope);
    } catch {
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    scopes.push(scope);
  }
  return scopes.slice(0, MAX_SCOPES_PER_SWEEP);
}

/**
 * Walk one scope's kernel lifecycle in `(occurred_at,id)` order and classify
 * every dispatched action. The first action still inside its budget stops the
 * walk: the cursor must not skip a live obligation.
 */
function scanScope(
  scope: CognitiveScope,
  now: number,
): { stale: StaleAction[]; lastResolvedId?: string; lastResolvedAt?: number; hasOpen: boolean } {
  const proposals = listCognitiveEvents({
    scope,
    type: 'action_envelope_proposed',
    order: 'occurred_at',
    limit: MAX_EVENTS_PER_SCOPE,
  });
  const transitions = listCognitiveEvents({
    scope,
    type: 'action_envelope_transition',
    order: 'occurred_at',
    limit: MAX_EVENTS_PER_SCOPE,
  });
  const outcomes = listCognitiveEvents({
    scope,
    type: 'action_envelope_outcome',
    order: 'occurred_at',
    limit: MAX_EVENTS_PER_SCOPE,
  });

  const closed = new Set<string>();
  for (const event of outcomes) {
    const envelopeId = envelopeIdOf(event);
    if (envelopeId) closed.add(envelopeId);
  }

  const proposalById = new Map<string, CognitiveEvent>();
  for (const event of proposals) {
    const envelope = event.fact['envelope'];
    if (!envelope || typeof envelope !== 'object') continue;
    const id = (envelope as { id?: unknown }).id;
    if (typeof id === 'string' && id.trim()) proposalById.set(id.trim(), event);
  }

  const timeline = [...proposals, ...transitions, ...outcomes]
    .sort((a, b) => a.occurredAt - b.occurredAt || a.id.localeCompare(b.id));

  const stale: StaleAction[] = [];
  let lastResolvedId: string | undefined;
  let lastResolvedAt: number | undefined;
  let hasOpen = false;

  for (const event of timeline) {
    if (event.type === 'action_envelope_outcome') {
      lastResolvedId = event.id;
      lastResolvedAt = event.occurredAt;
      continue;
    }
    if (event.type !== 'action_envelope_transition' || statusOf(event) !== 'dispatched') continue;
    const envelopeId = envelopeIdOf(event);
    if (!envelopeId) {
      lastResolvedId = event.id;
      lastResolvedAt = event.occurredAt;
      continue;
    }
    if (closed.has(envelopeId)) {
      lastResolvedId = event.id;
      lastResolvedAt = event.occurredAt;
      continue;
    }
    const proposal = proposalById.get(envelopeId);
    const envelope = proposal?.fact['envelope'];
    const startedAt = createdAtOf(envelope) ?? event.occurredAt;
    const deadline = startedAt + (proposal ? wallClockSec(envelope) : FALLBACK_WALL_CLOCK_SEC);
    if (now >= deadline) {
      stale.push({
        envelopeId,
        dispatchedAt: event.occurredAt,
        expandedDeadline: deadline,
        dispatchEventId: event.id,
      });
      lastResolvedId = event.id;
      lastResolvedAt = event.occurredAt;
      continue;
    }
    // Inside its host budget: leave it open and stop advancing here.
    hasOpen = true;
    break;
  }

  return {
    stale,
    ...(lastResolvedId === undefined ? {} : { lastResolvedId }),
    ...(lastResolvedAt === undefined ? {} : { lastResolvedAt }),
    hasOpen,
  };
}

/**
 * Close kernel actions whose dispatch budget expired without a host receipt.
 * Safe to run on every tick: lease-guarded, bounded, and it writes only
 * terminal `interrupted` outcomes for actions that are already open.
 */
export function recoverStaleKernelActions(
  options: CognitiveRecoveryOptions = {},
): CognitiveRecoveryResult {
  const result: CognitiveRecoveryResult = {
    scopesScanned: 0,
    scopesSkipped: 0,
    openActions: 0,
    recovered: 0,
    actions: [],
  };
  if (!recoveryEnabled()) return result;

  const now = options.now ?? nowSec();
  const lookbackSec = Math.min(
    DEFAULT_LOOKBACK_SEC,
    Math.max(60, Math.trunc(options.lookbackSec ?? DEFAULT_LOOKBACK_SEC)),
  );
  const owner = options.owner?.trim().slice(0, 120)
    || `kernel-recovery:${process.pid}:${randomUUID().slice(0, 8)}`;

  for (const scope of candidateScopes(now - lookbackSec, MAX_EVENTS_PER_SCOPE)) {
    let key: string;
    try {
      key = scopeKey(scope);
    } catch {
      continue;
    }
    const claim = claimCognitiveCursor({
      scope,
      stream: KERNEL_RECOVERY_STREAM,
      owner,
      ...(options.leaseSec === undefined ? {} : { leaseSec: options.leaseSec }),
      nowSec: now,
    });
    if (!claim || !claim.claimed) {
      result.scopesSkipped += 1;
      continue;
    }

    try {
      const scan = scanScope(scope, now);
      result.scopesScanned += 1;
      result.openActions += scan.stale.length;

      for (const action of scan.stale) {
        if (result.recovered >= MAX_SETTLEMENTS_PER_SWEEP) break;
        const settled = recordKernelActionOutcome({
          scope,
          envelopeId: action.envelopeId,
          status: 'interrupted',
          reason: 'recovery_stale_dispatch',
          occurredAt: now,
          causationId: action.dispatchEventId,
          receipt: {
            stage: 'recovery',
            reason: 'recovery_stale_dispatch',
            dispatchedAt: action.dispatchedAt,
            budgetExpiredAt: action.expandedDeadline,
            recoveredAt: now,
            recoveredBy: owner,
            resent: false,
          },
        });
        if (!settled) continue;
        result.recovered += 1;
        result.actions.push({
          scopeKey: key,
          envelopeId: action.envelopeId,
          dispatchedAt: action.dispatchedAt,
          closedAt: now,
          reason: 'recovery_stale_dispatch',
        });
      }

      // Never advance past an action that is still open and within budget.
      if (!scan.hasOpen && scan.lastResolvedId !== undefined && scan.lastResolvedAt !== undefined) {
        advanceCognitiveCursor({
          scope,
          stream: KERNEL_RECOVERY_STREAM,
          owner,
          position: { occurredAt: scan.lastResolvedAt, eventId: scan.lastResolvedId },
          nowSec: now,
        });
      }
    } catch (err) {
      logger.debug({ err, scopeKey: key }, 'kernel recovery sweep failed for scope');
    } finally {
      releaseCognitiveCursor({ scope, stream: KERNEL_RECOVERY_STREAM, owner });
    }
  }

  if (result.recovered > 0) {
    logger.info(
      { recovered: result.recovered, scopesScanned: result.scopesScanned },
      'kernel recovery closed stale dispatches',
    );
  }
  return result;
}
