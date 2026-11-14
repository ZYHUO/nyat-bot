// Host-owned executor for durable cognitive process wakes.
//
// A wake is not a model turn. This runtime performs only bounded projections
// that the host can verify (currently ConversationField -> InnerState), then
// checkpoints the wake and schedules a durable next wake. Model/tool/Telegram
// authority remains outside this module.

import { getBotIdentity } from '../bot/bot.js';
import { getRecent } from '../pipeline/context/manager.js';
import {
  checkpointProcess,
  listDueProcessWakes,
  requestProcessWake,
  hasCurrentProcessWakeSource,
  type CognitiveProcessKind,
  type ProcessWake,
} from './cognitive-continuity.js';
import { collectConversationField, deriveInnerStateFromConversationField } from './conversation-field.js';
import { recordInnerState } from './nyatos-state.js';
import { hasCurrentEmotionSource, projectInnerStateFromConversationField } from './emotion-continuity.js';
import { env } from '../env.js';
import { getCognitiveEvent } from './cognitive-events.js';
import { lifeProjectForWake } from './life-project.js';

const PROCESS_CADENCE_SEC: Record<CognitiveProcessKind, number> = {
  observer: 15 * 60,
  social_mind: 5 * 60,
  strategist: 60 * 60,
  skeptic: 30 * 60,
  memory_curator: 6 * 60 * 60,
};

export interface CognitiveProcessTickResult {
  claimed: number;
  completed: number;
  waiting: number;
  failed: number;
  projected: number;
  rescheduled: number;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function nextWakeAt(kind: CognitiveProcessKind, now: number): number {
  return Math.min(4_102_444_800, now + PROCESS_CADENCE_SEC[kind]);
}

async function projectConversation(wake: ProcessWake, now: number): Promise<string[]> {
  if (wake.scope.visibility !== 'chat' || wake.scope.chatId === undefined) return [];
  const recent = await getRecent(wake.scope.chatId, 30);
  const field = await collectConversationField({
    chatId: wake.scope.chatId,
    recent: env().EMOTION_CONTINUITY_ENABLED ? recent.filter((message) =>
      message.timestamp <= now && message.timestamp >= now - 3600
      && hasCurrentEmotionSource(wake.scope.chatId!, message.eventIdentity)) : recent,
    botUid: getBotIdentity(wake.scope.chatId).uid,
    nowSec: now,
    ...(wake.scope.taskId ? {} : {}),
    asOfEventId: wake.causeEventIds[0],
  });
  if (env().EMOTION_CONTINUITY_ENABLED) {
    const recorded = projectInnerStateFromConversationField(field, { causationId: wake.wakeEventId });
    if (!recorded) throw new Error('inner_state_projection_unavailable');
    return [recorded.eventId];
  }
  const state = deriveInnerStateFromConversationField(field);
  const recorded = recordInnerState(state, {
    scope: wake.scope,
    causationId: wake.wakeEventId,
    occurredAt: field.asOf,
  });
  return recorded ? [recorded.eventId] : [];
}

/** Consume due wakes with a lease-like append/checkpoint protocol. */
export async function runCognitiveProcessTick(
  now = nowSec(),
  limit = 20,
): Promise<CognitiveProcessTickResult> {
  const wakes = listDueProcessWakes(now, limit);
  const result: CognitiveProcessTickResult = {
    claimed: wakes.length,
    completed: 0,
    waiting: 0,
    failed: 0,
    projected: 0,
    rescheduled: 0,
  };
  for (const wake of wakes) {
    // Only an explicitly operator-activated project gets this bounded driver.
    // Ordinary model mission proposals retain their existing waiting behavior.
    const project = lifeProjectForWake(wake);
    if (project) {
      try {
        const { runLifeProjectWake } = await import('./life-project-runner.js');
        const outcome = await runLifeProjectWake(project, wake, now);
        if (outcome.status === 'completed') result.completed++;
        else if (outcome.status === 'waiting') result.waiting++;
        else result.failed++;
        if (outcome.outcomeEventId) result.projected++;
      } catch { result.failed++; }
      continue;
    }
    const resumeAt = nextWakeAt(wake.kind, now);
    let status: 'completed' | 'failed' | 'waiting' = 'waiting';
    let outcomeEventIds: string[] = [];
    try {
      if (wake.kind === 'observer' || wake.kind === 'social_mind') {
        outcomeEventIds = await projectConversation(wake, now);
        result.projected += outcomeEventIds.length;
        status = 'completed';
      }
      // Strategist/skeptic/memory_curator intentionally stop at a durable
      // checkpoint until their host-owned proposal/evidence handler is wired.
      // A waiting checkpoint is explicit and recoverable, not a fake success.
      if (status === 'completed') result.completed += 1;
      else result.waiting += 1;
    } catch {
      status = 'failed';
      result.failed += 1;
    }

    // The account could have changed while collecting context. Do not turn a
    // rejected old wake into a fresh wake under the new account on retry.
    if (env().EMOTION_CONTINUITY_ENABLED && wake.scope.visibility === 'chat'
      && !hasCurrentProcessWakeSource(getCognitiveEvent(wake.wakeEventId))) continue;
    const checkpoint = checkpointProcess({
      processId: wake.processId,
      wakeEventId: wake.wakeEventId,
      scope: wake.scope,
      status,
      nextWakeAt: resumeAt,
      outcomeEventIds,
      recordedAt: now,
    });
    if (!checkpoint?.inserted) continue;
    const rescheduled = requestProcessWake({
      processId: wake.processId,
      kind: wake.kind,
      scope: wake.scope,
      wakeAt: resumeAt,
      reason: 'periodic_resume',
      causeEventIds: [checkpoint.eventId, ...outcomeEventIds].slice(0, 8),
    });
    if (rescheduled?.inserted) result.rescheduled += 1;
  }
  return result;
}
