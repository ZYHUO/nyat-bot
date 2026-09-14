// Explicit Agency wait adapter. The host owns the timing state machine and
// returns a durable wait receipt; constructing this factory has no side effect.

import { validateAgencyAction } from './agency.js';
import type { AgencyAction } from './agency.js';
import type { AgencyAdapter, AgencyAdapters, AgencyAdapterContext } from './agency-runtime.js';
import type { CognitiveScope } from '../shared/cognitive-scope.js';

export interface AgencyWaitRequest {
  chatId: number;
  scope: CognitiveScope;
  reason: string;
  waitSec?: number;
  runId: string;
  attempt: number;
  correlationId: string;
  idempotencyKey: string;
  signal: AbortSignal;
}

export interface AgencyWaitResult {
  /** Epoch milliseconds at which the host considers the wait eligible to resume. */
  waitUntil: number;
  /** Host scheduler id, when the timing backend exposes one. */
  waitJobId?: string;
}

/** The host owns Redis/BullMQ scheduling and any chat timing state transition. */
export type AgencyWaitSchedule = (request: AgencyWaitRequest) => Promise<AgencyWaitResult>;

function scopedChatId(context: AgencyAdapterContext): number {
  const chatId = context.scope.chatId;
  if (context.scope.visibility === 'global' || chatId === undefined || !Number.isSafeInteger(chatId) || chatId === 0) {
    throw new Error('wait requires a scoped chat');
  }
  return chatId;
}

function checkedAction(action: AgencyAction): Extract<AgencyAction, { type: 'wait' }> {
  const checked = validateAgencyAction(action);
  if (!checked.ok || !checked.action || checked.action.type !== 'wait') {
    throw new Error('wait adapter action mismatch');
  }
  return checked.action;
}

function boundedWaitSec(waitSec: number | undefined): number | undefined {
  if (waitSec === undefined) return undefined;
  if (!Number.isFinite(waitSec) || waitSec < 0 || waitSec > 24 * 3600) {
    throw new Error('wait adapter received invalid waitSec');
  }
  return Math.floor(waitSec);
}

function checkedResult(result: AgencyWaitResult): AgencyWaitResult {
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || !Number.isSafeInteger(result.waitUntil) || result.waitUntil <= 0) {
    throw new Error('invalid wait receipt');
  }
  if (result.waitJobId !== undefined
    && (typeof result.waitJobId !== 'string' || !result.waitJobId.trim() || result.waitJobId.length > 240)) {
    throw new Error('invalid wait job id');
  }
  return {
    waitUntil: result.waitUntil,
    ...(result.waitJobId !== undefined ? { waitJobId: result.waitJobId.trim() } : {}),
  };
}

function waitAdapter(schedule: AgencyWaitSchedule): AgencyAdapter {
  return async (rawAction, context) => {
    const action = checkedAction(rawAction);
    const chatId = scopedChatId(context);
    if (context.signal.aborted) throw new Error('agency run cancelled');

    context.usage.consumeToolCall();
    const result = await schedule({
      chatId,
      scope: context.scope,
      reason: action.reason,
      ...(action.waitSec !== undefined ? { waitSec: boundedWaitSec(action.waitSec) } : {}),
      runId: context.runId,
      attempt: context.attempt,
      correlationId: context.correlationId,
      idempotencyKey: context.idempotencyKey,
      signal: context.signal,
    });
    return checkedResult(result);
  };
}

/** Build an explicit wait adapter for a caller-owned timing backend. */
export function createAgencyWaitAdapters(schedule: AgencyWaitSchedule): Pick<AgencyAdapters, 'wait'> {
  return { wait: waitAdapter(schedule) };
}

/**
 * Bind the generic contract to the existing chat timing FSM. This remains an
 * explicit opt-in binding; callers still need an authority/canary dispatch.
 */
export interface TimingAgencyWaitMetadata {
  anchorMessageId?: number;
  triggerUserId?: number;
  obligationId?: string;
}

export function createTimingAgencyWaitAdapters(metadata?: TimingAgencyWaitMetadata): Pick<AgencyAdapters, 'wait'> {
  return createAgencyWaitAdapters(async ({ chatId, waitSec }) => {
    const { env } = await import('../env.js');
    const timingEnv = env();
    if (!timingEnv.TIMING_GATE_ENABLED) throw new Error('timing wait unavailable');

    const effectiveWaitSec = waitSec ?? timingEnv.TIMING_WAIT_MIN_SEC;
    const { getChatState, transitionToWait } = await import('../pipeline/timing/chat-runtime.js');
    if (metadata && (metadata.anchorMessageId !== undefined || metadata.triggerUserId !== undefined || metadata.obligationId !== undefined)) {
      await transitionToWait(chatId, effectiveWaitSec, metadata.anchorMessageId, metadata.triggerUserId, metadata.obligationId);
    } else {
      await transitionToWait(chatId, effectiveWaitSec);
    }
    const state = await getChatState(chatId);
    if (state.state !== 'WAIT' || !state.waitUntil || !Number.isSafeInteger(state.waitUntil)) {
      throw new Error('timing wait did not enter WAIT');
    }
    return {
      waitUntil: state.waitUntil,
      ...(state.waitJobId ? { waitJobId: state.waitJobId } : {}),
    };
  });
}
