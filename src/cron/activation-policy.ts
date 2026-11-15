import { env } from '../env.js';
import type { FormattedMessage } from '../shared/types.js';

type ActivityMessage = Pick<FormattedMessage, 'role' | 'uid' | 'timestamp' | 'isBot' | 'isAnonymous'>;

export type ProactiveActivationReason =
  | 'disabled'
  | 'human_after_activation'
  | 'no_human_after_activation'
  | 'invalid_activation_epoch'
  | 'activity_unavailable';

export interface ProactiveActivationDecision {
  allowed: boolean;
  reason: ProactiveActivationReason;
  lastHumanAtSec: number | null;
}

export interface ProactiveActivationOptions {
  activationEpochSec?: number;
  nowSec?: number;
  recentMessages?: readonly ActivityMessage[];
}

function isValidTimestamp(value: number, nowSec: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= nowSec;
}

/** Original message time, never arrival time or a bot-generated context row. */
export function lastHumanMessageAtSec(
  messages: readonly ActivityMessage[],
  nowSec: number = Math.floor(Date.now() / 1000),
): number | null {
  let latest: number | null = null;
  for (const message of messages) {
    if (
      message.role !== 'user' || message.isBot || message.isAnonymous ||
      !Number.isSafeInteger(message.uid) || message.uid <= 0 ||
      message.uid === 1087968824 || !isValidTimestamp(message.timestamp, nowSec)
    ) continue;
    latest = Math.max(latest ?? 0, message.timestamp);
  }
  return latest;
}

export function evaluateProactiveActivation(
  activationEpochSec: number,
  lastHumanAtSec: number | null,
  nowSec: number = Math.floor(Date.now() / 1000),
): ProactiveActivationDecision {
  if (activationEpochSec === 0) return { allowed: true, reason: 'disabled', lastHumanAtSec };
  if (!isValidTimestamp(activationEpochSec, nowSec)) {
    return { allowed: false, reason: 'invalid_activation_epoch', lastHumanAtSec };
  }
  const allowed = lastHumanAtSec !== null &&
    isValidTimestamp(lastHumanAtSec, nowSec) && lastHumanAtSec > activationEpochSec;
  return {
    allowed,
    reason: allowed ? 'human_after_activation' : 'no_human_after_activation',
    lastHumanAtSec,
  };
}

/**
 * Gate proactive destination chats after a restore, without modifying old data.
 * Context membership is written only for human user messages by addMessage and
 * stores their original timestamp as lastSeen. It spans forum topics and DMs.
 * The silence-alert lastHuman key instead records arrival time, so cannot prove
 * that a replayed Telegram message was originally sent after activation.
 */
export async function checkProactiveActivation(
  chatId: number,
  options: ProactiveActivationOptions = {},
): Promise<ProactiveActivationDecision> {
  const activationEpochSec = options.activationEpochSec ?? env().PROACTIVE_ACTIVATED_AT_SEC ?? 0;
  const nowSec = options.nowSec ?? Math.floor(Date.now() / 1000);
  let lastHumanAtSec = lastHumanMessageAtSec(options.recentMessages ?? [], nowSec);
  const initial = evaluateProactiveActivation(activationEpochSec, lastHumanAtSec, nowSec);
  if (initial.allowed || initial.reason === 'invalid_activation_epoch') return initial;

  try {
    const { getGroupMembers } = await import('../pipeline/context/manager.js');
    const members = await getGroupMembers(chatId);
    for (const member of members) {
      if (
        !Number.isSafeInteger(member.uid) || member.uid <= 0 || member.uid === 1087968824 ||
        !isValidTimestamp(member.lastSeen, nowSec)
      ) continue;
      lastHumanAtSec = Math.max(lastHumanAtSec ?? 0, member.lastSeen);
    }
    return evaluateProactiveActivation(activationEpochSec, lastHumanAtSec, nowSec);
  } catch {
    // A missing activity store must not reactivate restored destinations.
    return { allowed: false, reason: 'activity_unavailable', lastHumanAtSec };
  }
}
