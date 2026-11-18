import { createHash } from 'node:crypto';
import { canonicalJson } from '../shared/event-identity.js';
import { isInFlightCodeActForUser } from './speaker-burst.js';
import { selectHeartTargets } from './heart-targets.js';
import { withWaitRecheckSlot } from './wait-recheck-slot.js';
import type { WaitRecheckControl } from './wait-recheck-slot.js';
import { env } from '../env.js';
import { getRedis } from '../db/redis.js';
import { isGroupAllowed } from '../allowlist/allowlist.js';
import { configFromEnv } from '../allowlist/bot-flow.js';
import { matchesContextScope, resolveContextScope } from '../context-engine/scope.js';
import { isMessageInContextScope } from '../pipeline/context/storage-scope.js';
import { getRecent } from '../pipeline/context/manager.js';
import { getChatState } from '../pipeline/timing/chat-runtime.js';
import { isOneBotMessageRecalled } from '../platform/onebot-notices.js';
import { checkCodeActActivation } from '../subagent/activation-policy.js';
import { getSleepPhase } from '../tracking/sleep.js';
import type { FormattedMessage } from '../shared/types.js';
import { getAttentionAccumulator } from './index.js';
import { isMessageAnswered } from './answered.js';
import { metaMuteBlocksReply } from './ingress-intercepts.js';
import { assertInputBatchCurrent, hasUnansweredIntentRevision } from './pending-intent.js';
import { heartRoute, hasTimedBypass } from './heart-route.js';
import { evaluateMetaHeart } from './heart-adapter.js';
import { evaluateMetaTiming } from './timing-adapter.js';
import type { MetaWaitAnchor, MetaWaitResume } from './timing-adapter.js';

/** Only source-bearing fields affect this fence; storage annotations do not. */
function fingerprint(messages: readonly FormattedMessage[]): string {
  return createHash('sha256').update(canonicalJson(messages.map(message => [message.messageId,
    message.uid, message.role, message.messageThreadId ?? 0, message.textContent,
    message.captionContent, message.replyTo, message.eventIdentity?.eventId,
    message.eventIdentity?.revision]))).digest('hex');
}

/** A timer supplies no authority. Recheck the original sources against the live
 * scoped context, policy and claimed generation before every external effect. */
export async function recheckMetaWaitAnchor(anchor: MetaWaitAnchor, resume: MetaWaitResume): Promise<void> {
  const { chatId } = anchor;
  const scope = resolveContextScope(chatId, anchor.messageThreadId);
  const messages = anchor.heartMessages;
  if (!scope || scope.conversationKind !== 'group' || chatId >= 0 || !anchor.contextScope
    || !matchesContextScope(anchor.contextScope, scope) || !resume.waitGeneration
    || anchor.waitGeneration !== resume.waitGeneration || anchor.messageId !== resume.anchorMessageId
    || !messages?.length || messages.length > 32) return;
  const waitGeneration = resume.waitGeneration;
  const source = messages[messages.length - 1]!;
  if (source.messageId !== anchor.messageId || source.uid !== anchor.userId) return;
  const route = heartRoute(env(), chatId);
  // A configuration handoff must not recycle an old Heart authorization.
  if (route === 'bypass') return;
  let contextFingerprint: string | undefined;
  let control: WaitRecheckControl | undefined;
  // Frequent model-boundary checks stay cheap. The full source/policy read is
  // reserved for initial admission, actual effects and durable persistence.
  const stillClaimed = async (): Promise<boolean> => {
    try {
      const liveScope = resolveContextScope(chatId, anchor.messageThreadId);
      if (control && !await control.isCurrent()) return false;
      if (!env().TIMING_GATE_ENABLED || !checkCodeActActivation(anchor).allowed || !liveScope
        || !matchesContextScope(scope, liveScope) || heartRoute(env(), chatId) !== route
        || anchor.ongoingFollowup && !isInFlightCodeActForUser(chatId, source.uid)) return false;
      assertInputBatchCurrent(messages);
      const state = await getChatState(chatId);
      return state.state === 'RUNNING' && state.waitGeneration === resume.waitGeneration;
    } catch { return false; }
  };
  const current = async (): Promise<boolean> => {
    try {
      const config = env();
      if (!await stillClaimed() || await hasTimedBypass(chatId, true)
        || await getSleepPhase(undefined, true, true) !== 'awake') return false;
      if (scope.platform === 'telegram') {
        if (!await isGroupAllowed(getRedis(), configFromEnv(config), chatId)) return false;
      } else {
        const allowed = String(config.ONEBOT_ALLOWED_GROUP_IDS ?? '').split(',').map(id => id.trim()).filter(Boolean);
        if (!config.ONEBOT_ENABLED || config.ONEBOT_ACCOUNT_ID !== scope.accountId
          || allowed.length > 0 && messages.some(message => !allowed.includes(message.eventIdentity?.ref.conversation.id ?? ''))) return false;
      }
      assertInputBatchCurrent(messages);
      const recent = await getRecent(chatId, 40, anchor.messageThreadId);
      if (recent.some(message => !isMessageInContextScope(message, scope))) return false;
      for (const message of messages) {
        const identity = message.eventIdentity, ref = message.pendingIntent;
        if (!isMessageInContextScope(message, scope) || message.role !== 'user' || message.isBot
          || message.isAnonymous || message.uid <= 0 || !identity || !Number.isSafeInteger(identity.receivedAt)
          || identity.receivedAt < config.META_ACTIVATED_AT_SEC * 1000
          || identity.receivedAt > Date.now() + 60_000
          || config.META_PENDING_INTENT_ENABLED && !ref
          || ref && (ref.chatId !== chatId || ref.senderId !== message.uid || ref.threadId !== (message.messageThreadId ?? 0)
            || ref.accountId !== scope.accountId || ref.platform !== scope.platform)
          || metaMuteBlocksReply(chatId, message, !!anchor.addressed)
          || isOneBotMessageRecalled(chatId, message.messageId)
          || !hasUnansweredIntentRevision(ref) && await isMessageAnswered(chatId, message.messageId, true)) return false;
        const live = recent.find(item => item.messageId === message.messageId && item.uid === message.uid);
        if (!live || fingerprint([message]) !== fingerprint([live])) return false;
      }
      const observed = fingerprint(recent);
      if (contextFingerprint !== undefined && observed !== contextFingerprint) return false;
      contextFingerprint = observed;
      // Reads above may yield to cancellation; recheck the generation last.
      return stillClaimed();
    } catch { return false; }
  };
  if (!await current()) return;
  // A whole batch is context. Different quotes retain their source anchors,
  // bound only to the latest frozen revision in the same author lane.
  const { anchors, currentRefs } = selectHeartTargets(messages, message => message);
  // QQ Heart still decides only for its original ★ anchor. Its schema does
  // not implement Telegram's multi-target selector; older bubbles stay context.
  const candidates = anchors.filter(message => (scope.platform === 'telegram' || message.messageId === source.messageId)
    && (!anchor.targetMessageIds || anchor.targetMessageIds.includes(message.messageId)));
  if (!candidates.length) return;
  const targetMessageIds = candidates.map(message => message.messageId);
  const evaluate = async (slot?: WaitRecheckControl): Promise<void> => {
    control = slot;
    if (!await current()) return;
    const beforeEffect = async (): Promise<boolean> => await current() && (!control || await control.beginEffects()) && await stillClaimed();
    const verdict = route === 'heart'
      ? await evaluateMetaHeart({ chatId, formatted: source, layer: anchor.layer,
        batchMessages: messages, targetMessageIds: scope.platform === 'telegram' ? targetMessageIds : undefined, addressed: anchor.addressed,
        cognitiveAnchorEventId: anchor.cognitiveAnchorEventId, waitResume: true,
        signal: control?.signal, isCurrent: stillClaimed, beforeEffect })
      : { ...await evaluateMetaTiming({ chatId, formatted: source, isDirect: false,
        layer: anchor.layer, cognitiveAnchorEventId: anchor.cognitiveAnchorEventId,
        waitResume: true, isCurrent: stillClaimed }), layer: anchor.layer, targetMessageIds: [source.messageId] };
    if (verdict.verdict !== 'allow' || !await current()) return;
    const selected = verdict.targetMessageIds ?? (targetMessageIds.length === 1 ? targetMessageIds : []);
    if (!selected.length || selected.some(id => !targetMessageIds.includes(id))) return;
    for (const message of candidates) {
      if (!selected.includes(message.messageId) || !await beforeEffect()) continue;
      await getAttentionAccumulator().ingestAsync({ chatId, messageId: message.messageId,
        userId: message.uid, pendingIntent: message.pendingIntent ? currentRefs.get(message.pendingIntent.laneKey) : undefined,
        messageThreadId: message.messageThreadId,
        waitRecovery: { generation: waitGeneration, threadId: anchor.messageThreadId ?? 0, chatId, accountId: scope.accountId, platform: scope.platform },
        layer: verdict.layer, reason: `wait_resume:${verdict.reason}`,
        textPreview: (message.textContent || '').slice(0, 200),
        cognitiveAnchorEventId: message.eventIdentity?.eventId,
        payload: { username: message.username, fullName: message.fullName, heartBatchTarget: true,
          ...('path' in verdict ? { heartPath: verdict.path } : {}),
          ...(message.replyTo ? { replyTo: message.replyTo } : {}) },
      }, { requireDurable: true, beforePersist: current });
    }
  };
  if (route === 'heart' && scope.platform === 'telegram') {
    await withWaitRecheckSlot({ chatId, formatted: source, layer: anchor.layer, addressed: !!anchor.addressed,
      cognitiveAnchorEventId: anchor.cognitiveAnchorEventId }, evaluate, stillClaimed);
  } else await evaluate();
}
