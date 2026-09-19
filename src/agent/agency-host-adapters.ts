// Host implementations for the Agency control actions.
//
// `agency-control-adapters.ts` provides factories that enforce scope, action
// shape, budget accounting and receipt contracts — but they take the actual host
// operation as a callback, and nothing ever supplied one. The result: the agency
// runtime could dispatch an `observe`/`remember`/`correct`/`stop` action and had
// no implementation to hand it.
//
// These are deliberately small. Each one performs exactly the host operation the
// adapter contract promises and nothing more:
//
//   observe   → read from an allowlisted host source, never a free-form fetch
//   remember  → write a memory through the existing memory layer
//   correct   → resolve a cognitive debt (the host owns "was this addressed?")
//   stop      → record that the run was asked to stop
//
// The safety posture matches the rest of the Agency surface: read-only by
// default, every action already scope-checked by the adapter wrapper, and a
// failure here must never widen what the model can do.

import { logger } from '../shared/logger.js';
import type { AgencyAdapterContext } from './agency-runtime.js';
import { env } from '../env.js';
import type {
  AgencyObserve,
  AgencyObserveRequest,
  AgencyObserveResult,
  AgencyRemember,
  AgencyRememberRequest,
  AgencyRememberResult,
  AgencyCorrect,
  AgencyCorrectRequest,
  AgencyCorrectResult,
  AgencyStop,
  AgencyStopRequest,
  AgencyStopResult,
} from './agency-control-adapters.js';

/**
 * Read a host source.
 *
 * Only sources the host explicitly recognises are served. An unrecognised target
 * returns an empty result rather than performing a fetch — the model names a
 * source, it does not get to invent one.
 */
const OBSERVE_SOURCES = new Set([
  'chat.recent',
  'chat.summary',
  'self.state',
]);

export const observeFromHost: AgencyObserve = async (
  request: AgencyObserveRequest,
): Promise<AgencyObserveResult> => {
  const { target, chatId } = request;
  if (!OBSERVE_SOURCES.has(target)) {
    logger.debug({ target, chatId }, 'agency observe: unrecognised source (returning empty)');
    return { data: null };
  }
  try {
    if (target === 'chat.recent') {
      const { getRecent } = await import('../pipeline/context/manager.js');
      const { slimSingleMessage } = await import('../pipeline/context/slim.js');
      const { getBotUid } = await import('../bot/bot.js');
      const recent = await getRecent(chatId, 12);
      const botUid = getBotUid() || 0;
      return { data: recent.map((m) => slimSingleMessage(m, botUid)) };
    }
    if (target === 'chat.summary') {
      const { getGroupNorms } = await import('./group-norms.js');
      const norms = getGroupNorms(chatId);
      return { data: norms ? { norms: norms.norms, sampleCount: norms.sampleCount } : null };
    }
    // self.state
    const { composeSelfState } = await import('../pipeline/heart/self-state.js');
    return { data: await composeSelfState(chatId) };
  } catch (err) {
    logger.debug({ err, target, chatId }, 'agency observe failed (returning empty)');
    return { data: null };
  }
};

/**
 * Persist a fact the run decided is worth keeping.
 *
 * Routed through the existing memory layer so it inherits importance scoring,
 * visibility and per-chat isolation rather than creating a parallel store.
 */
export const rememberViaHost: AgencyRemember = async (
  request: AgencyRememberRequest,
): Promise<AgencyRememberResult> => {
  const { fact, chatId, scope } = request;
  const text = fact.trim().slice(0, 500);
  if (!text) return { memoryId: '' };
  try {
    // Routed through `core_beliefs`, the durable per-scope fact store. It
    // REQUIRES evidence ("无 evidence 不落库"), which is the right constraint for
    // an agency action: a run may record what it observed, not what it asserts.
    // The run id is the provenance, so the write is traceable and idempotent.
    const { upsertBelief } = await import('../core/beliefs/store.js');
    const id = upsertBelief({
      sourceTable: 'agency_run',
      sourceRowId: 0,
      predicate: 'agency.fact',
      summary: text,
      evidence: [`agency run ${request.runId}`],
      scope,
    });
    return { memoryId: String(id ?? '') };
  } catch (err) {
    logger.debug({ err, chatId }, 'agency remember failed');
    return { memoryId: '' };
  }
};

/**
 * Resolve a debt.
 *
 * `correct` exists so a run can close something it actually addressed. The host
 * owns the decision of whether the resolution is real, which is why this only
 * resolves a debt id the run already holds — it cannot create one.
 */
export const correctViaHost: AgencyCorrect = async (
  request: AgencyCorrectRequest,
): Promise<AgencyCorrectResult> => {
  const { debtId, resolution, chatId } = request;
  if (!Number.isSafeInteger(debtId) || debtId <= 0) {
    return { resolved: false, resolutionEventId: '' };
  }
  try {
    const { resolveDebt } = await import('./cognitive-debts.js');
    const resolved = resolveDebt(debtId, resolution);
    return { resolved, resolutionEventId: resolved ? `debt:${debtId}` : '' };
  } catch (err) {
    logger.debug({ err, debtId, chatId }, 'agency correct failed');
    return { resolved: false, resolutionEventId: '' };
  }
};

/**
 * Record that a run was asked to stop.
 *
 * Only records — cancelling the in-flight work is the runtime's job, and it must
 * not depend on this callback succeeding.
 */
export const stopViaHost: AgencyStop = async (
  request: AgencyStopRequest,
): Promise<AgencyStopResult> => {
  const { runId, reason } = request;
  const stoppedAt = Math.floor(Date.now() / 1000);
  logger.info({ runId, reason: reason.slice(0, 80) }, 'agency run stop requested');
  return { stoppedAt, stopId: `stop:${runId}:${stoppedAt}` };
};

/** Build the full adapter set from the host implementations above. */
export function buildAgencyControlAdapters() {
  return {
    observe: observeFromHost,
    remember: rememberViaHost,
    correct: correctViaHost,
    stop: stopViaHost,
  };
}

/** True when the host should hand these adapters to the runtime. */
export function agencyControlAdaptersEnabled(): boolean {
  try {
    return env().AGENCY_CONTROL_ADAPTERS_ENABLED === true;
  } catch {
    return false;
  }
}

/**
 * Bridge the runtime's `(action, context)` adapter shape onto the real host
 * operations above.
 *
 * The runtime and the control-adapter factories were built with different
 * signatures, which is why nothing connected them: `agency-proposals.ts` passed
 * a local stub that only returned `{recorded: true}` and never read anything.
 */
export function runtimeAdaptersFromHost(): Partial<
  Record<string, (action: unknown, context: AgencyAdapterContext) => Promise<unknown>>
> {
  const base = (context: AgencyAdapterContext, chatId: number) => ({
    chatId,
    scope: context.scope,
    runId: context.runId,
    attempt: context.attempt,
    correlationId: context.correlationId,
    idempotencyKey: context.idempotencyKey,
    signal: context.signal,
  });
  return {
    observe: async (action, context) => {
      const a = action as { target?: string };
      const chatId = context.scope.chatId ?? 0;
      if (!chatId) return { data: null };
      return observeFromHost({ ...base(context, chatId), target: String(a.target ?? '') });
    },
    remember: async (action, context) => {
      const a = action as { fact?: string };
      const chatId = context.scope.chatId ?? 0;
      return rememberViaHost({ ...base(context, chatId), fact: String(a.fact ?? '') });
    },
    correct: async (action, context) => {
      const a = action as { debtId?: number; resolution?: string };
      const chatId = context.scope.chatId ?? 0;
      return correctViaHost({
        ...base(context, chatId),
        debtId: Number(a.debtId ?? 0),
        resolution: String(a.resolution ?? ''),
      });
    },
    stop: async (action, context) => {
      const a = action as { reason?: string };
      const chatId = context.scope.chatId ?? 0;
      return stopViaHost({ ...base(context, chatId), reason: String(a.reason ?? '') });
    },
  };
}
