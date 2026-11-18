import { telegramHeartBatchPolicyCurrent } from './telegram-heart-policy.js';
import { env } from '../env.js';
import { logger } from '../shared/logger.js';
import { incrCounter } from '../metrics/registry.js';
import { cancelWaitForScope } from '../pipeline/timing/chat-runtime.js';
import { checkCodeActActivation } from '../subagent/activation-policy.js';
import { resolveConversationScope } from '../shared/privacy-scope.js';
import { batchMessagesAnswered } from './answered.js';
import { evaluateMetaHeart } from './heart-adapter.js';
import { selectHeartTargets } from './heart-targets.js';
import { telegramHeartPhysicalBodyHash, telegramHeartWaitContext } from './heart-source-fingerprint.js';
import { captureTelegramHeartWaitFence, isTelegramHeartWaitFenceCurrent } from './telegram-heart-wait-fence.js';
import { registerTelegramWaitAttention } from './telegram-heart-wait-handoff.js';
import { getAttentionAccumulator } from './index.js';
import { metaMuteBlocksReply } from './ingress-intercepts.js';
import { assertInputBatchCurrent, hasUnansweredIntentRevision, inspectPendingIntent } from './pending-intent.js';
import type { PendingIntentRef } from './pending-intent.js';
import type { TelegramHeartCandidate, TelegramHeartBatchControl } from './telegram-heart-batch.js';

/** Preserve each speaker's whole input as context, but only a current revision
 * may authorize dispatch. Another author's last message never grants that right. */
async function currentCandidates(batch: TelegramHeartCandidate[]): Promise<TelegramHeartCandidate[]> {
  const epoch = env().META_ACTIVATED_AT_SEC;
  const fresh = (item: TelegramHeartCandidate): boolean => {
    const event = item.formatted.eventIdentity;
    const now = Date.now();
    const sourceTime = event?.editedAt ?? event?.occurredAt;
    return Number.isSafeInteger(epoch) && epoch > 0 && !!event && event.occurredAt !== null
      && event.occurredAt >= epoch * 1000 && event.occurredAt <= now + 60_000
      && !!sourceTime && sourceTime >= event.occurredAt && sourceTime <= now + 60_000
      && now - sourceTime <= 5 * 60_000 && event.receivedAt >= sourceTime - 60_000
      && event.receivedAt <= now + 60_000 && now - event.receivedAt <= 5 * 60_000;
  };
  const latest = new Map<string, PendingIntentRef>();
  for (const item of batch) {
    const ref = item.formatted.pendingIntent;
    if (ref && ref.revision > (latest.get(ref.laneKey)?.revision ?? 0)) latest.set(ref.laneKey, ref);
  }
  const valid = new Set<string>();
  for (const [lane, ref] of latest) {
    const current = inspectPendingIntent(ref);
    if (current.state === 'pending' && current.currentRevision === ref.revision) valid.add(lane);
  }
  const result: TelegramHeartCandidate[] = [];
  const receiptChecks: Array<{ chatId: number; messageId: number }> = [];
  // Check only the latest received body of a message. A receipt for its
  // original version must not hide an authorized later edit with the same id.
  const sources = new Map<number, TelegramHeartCandidate>();
  for (const item of batch) {
    sources.delete(item.formatted.messageId);
    sources.set(item.formatted.messageId, item);
  }
  for (const item of sources.values()) {
    const message = item.formatted, ref = message.pendingIntent;
    if (!ref || !fresh(item) || !valid.has(ref.laneKey) || latest.get(ref.laneKey)?.intentId !== ref.intentId
      || metaMuteBlocksReply(item.chatId, message, false)) continue;
    if (message.eventIdentity?.revision === 'original' || !hasUnansweredIntentRevision(ref)) {
      receiptChecks.push({ chatId: item.chatId, messageId: message.messageId });
    }
    result.push(item);
  }
  const answered = await batchMessagesAnswered(receiptChecks, true);
  return result.filter(item => !answered.has(`${item.chatId}:${item.formatted.messageId}`));
}

/** No input/body is inspected by Heart until all candidates agree on scope. */
function assertBatchScope(batch: TelegramHeartCandidate[]): void {
  const first = batch[0];
  if (!first) return;
  const scope = resolveConversationScope(first.chatId);
  const threadId = first.formatted.messageThreadId ?? 0;
  if (!scope?.accountId || scope.platform !== 'telegram' || scope.conversationKind !== 'group') throw new Error('telegram_heart_scope_invalid');
  for (const item of batch) {
    const message = item.formatted, source = message.eventIdentity, ref = message.pendingIntent;
    const conversation = source?.ref.conversation;
    if (item.chatId !== first.chatId || item.addressed || message.isBot || message.isAnonymous || message.role !== 'user'
      || (message.messageThreadId ?? 0) !== threadId || !source || !ref
      || conversation?.platform !== 'telegram' || conversation.idNamespace !== 'telegram' || conversation.accountId !== scope.accountId
      || conversation.conversationKind !== 'group' || conversation.id !== String(first.chatId)
      || Number(conversation.threadId ?? 0) !== threadId || source.ref.id !== String(message.messageId)
      || ref.platform !== 'telegram' || ref.accountId !== scope.accountId || ref.chatId !== first.chatId
      || ref.senderId !== message.uid || ref.threadId !== threadId) throw new Error('cross_scope_heart_batch');
  }
}

export async function processTelegramHeartBatch(batch: TelegramHeartCandidate[], signal: AbortSignal,
  control: TelegramHeartBatchControl): Promise<void> {
  if (!batch.length || signal.aborted) return;
  assertBatchScope(batch);
  const chatId = batch[0]!.chatId;
  const threadId = batch[0]!.formatted.messageThreadId ?? 0;
  if (!await telegramHeartBatchPolicyCurrent(chatId)) return;
  // A waiting row is a pointer to a decision, not proof that the old body is
  // still present. Do not reject an unrelated author when one source vanishes.
  const hasWait = env().TIMING_GATE_ENABLED && env().CODEACT_ISOLATION_ENABLED && batch.some(item => item.waitUntilMs !== undefined);
  const recent = hasWait ? await telegramHeartWaitContext(chatId, threadId) : undefined;
  const observed = new Map(recent?.map(message => [message.messageId, message]));
  const present = batch.filter(item => {
    if (item.waitUntilMs === undefined) return true;
    if (!hasWait || !checkCodeActActivation({ chatId, createdAt: item.formatted.eventIdentity?.receivedAt }).allowed) return false;
    const source = observed.get(item.formatted.messageId);
    if (source && !source.isBot && !source.isAnonymous
      && telegramHeartPhysicalBodyHash(source) === telegramHeartPhysicalBodyHash(item.formatted)) return true;
    incrCounter('telegram_heart_wait_source_skipped_total', { reason: source ? 'changed' : 'not_in_recent' });
    return false;
  });
  const live = await currentCandidates(present);
  const anchor = live[live.length - 1];
  if (!anchor || signal.aborted || !await control.isCurrent()) return;
  const messages = live.map(item => item.formatted);
  const waiting = live.filter(item => item.waitUntilMs !== undefined);
  const waitRecovery = waiting.length ? captureTelegramHeartWaitFence(chatId, threadId, control.scopeVersion) : undefined;
  if (waiting.length && !waitRecovery) throw new Error('telegram_heart_wait_generation_changed');
  const contextHashes = waitRecovery && recent ? recent.map(telegramHeartPhysicalBodyHash) : undefined;
  const isCurrent = async (): Promise<boolean> => {
    if (signal.aborted || !await telegramHeartBatchPolicyCurrent(chatId)
      || !await control.isCurrent()) return false;
    assertBatchScope(live);
    if (waitRecovery && !await isTelegramHeartWaitFenceCurrent(waitRecovery)) {
      // A direct input/stop or policy can withdraw the decision. An independent
      // arrival may change just the snapshot. Retry pure work against the new one.
      if (!captureTelegramHeartWaitFence(chatId, threadId, control.scopeVersion)) throw new Error('telegram_heart_wait_generation_changed');
      return false;
    }
    assertInputBatchCurrent(messages);
    // Re-evaluate remaining valid authors when one source changes. Throwing
    // keeps this pure attempt eligible for bounded retry; once effects started
    // the durable store records unknown and cannot repeat a partial publication.
    if ((await currentCandidates(live)).length !== live.length) throw new Error('telegram_heart_inputs_changed');
    return !signal.aborted;
  };
  const currentForEffect = async (): Promise<boolean> => {
    if (contextHashes) {
      const current = await telegramHeartWaitContext(chatId, threadId);
      if (current.length !== contextHashes.length || current.some((source, i) => telegramHeartPhysicalBodyHash(source) !== contextHashes[i])) {
        throw new Error('telegram_heart_wait_context_changed');
      }
    }
    return isCurrent();
  };
  const beforeEffect = async (): Promise<boolean> => await currentForEffect() && await control.beginEffects() && await isCurrent();
  // Idempotent local cleanup, deliberately before effect-started: cancelling
  // the obsolete WAIT for this exact topic does not publish a reply or a new job.
  if (!waiting.length) await cancelWaitForScope(chatId, threadId);
  if (!await isCurrent()) return;
  // Every distinct current source stays selectable, including unquoted
  // independent questions, with the frozen current revision of that author.
  const { anchors, currentRefs } = selectHeartTargets(live, item => item.formatted);
  const allowedTargets = anchors.map(item => item.formatted.messageId);
  const onDecision = async (act: 'wait' | 'reply' | 'react', ids: readonly number[], waitSec: number): Promise<boolean> => {
    if (act !== 'wait' && !waiting.length) return true;
    if (!await currentForEffect()) return false;
    const selected = new Set(ids);
    // Even one speaker can have two independent questions. Only a selected
    // source or its explicit parent identifies an old question as addressed.
    // Other early WAITs retain their first deadline, without forcing a reply.
    const quoted = new Set(live.filter(item => selected.has(item.formatted.messageId))
      .map(item => item.formatted.replyTo?.messageId));
    const keep = live.filter(item => {
      if (item.waitUntilMs !== undefined && item.waitUntilMs <= Date.now()) return false;
      if (act === 'wait') return selected.has(item.formatted.messageId);
      return item.waitUntilMs !== undefined && !selected.has(item.formatted.messageId) && !quoted.has(item.formatted.messageId);
    });
    if (!keep.length) return act !== 'wait';
    if (!control.defer) throw new Error('telegram_heart_wait_storage_unavailable');
    if (control.defer(keep.map(item => item.formatted.messageId), waitSec)) return true;
    // A source can become due between the host read and the SQLite transaction.
    // Its deadline may end that WAIT but cannot veto a separate valid reply.
    if (keep.every(item => item.waitUntilMs !== undefined && item.waitUntilMs <= Date.now())) return act !== 'wait';
    throw new Error('telegram_heart_wait_storage_changed');
  };
  const heart = await evaluateMetaHeart({ chatId, formatted: anchor.formatted, layer: anchor.layer,
    cognitiveAnchorEventId: anchor.cognitiveAnchorEventId, batchMessages: messages, targetMessageIds: allowedTargets,
    telegramBatchWait: { reconsidering: waiting.map(item => item.formatted.messageId), recentMessages: recent, onDecision },
    addressed: false, signal, isCurrent, beforeEffect });
  if (!await isCurrent()) return;
  if (heart.verdict !== 'allow') return;
  const targets = heart.targetMessageIds ?? (allowedTargets.length === 1 ? allowedTargets : []);
  if (!targets.length || targets.some(id => !allowedTargets.includes(id))) return;
  const pressure = (heart.layer === 'L0' ? 100 : heart.layer === 'L1' ? 70 : 30) + (heart.pressureBoost ?? 0);
  let dispatched = 0;
  for (const item of anchors) {
    if (!targets.includes(item.formatted.messageId)) continue;
    if (!await beforeEffect()) return;
    const message = item.formatted;
    const attention = await getAttentionAccumulator().ingestAsync({ chatId, layer: heart.layer, reason: heart.reason,
      pressure, pendingIntent: currentRefs.get(message.pendingIntent!.laneKey), messageId: message.messageId, userId: message.uid,
      ...(item.waitUntilMs !== undefined ? { waitRecovery, telegramWaitSourceEventId: message.eventIdentity!.eventId } : {}),
      textPreview: (message.textContent || '').slice(0, 200), messageThreadId: message.messageThreadId,
      cognitiveAnchorEventId: item.cognitiveAnchorEventId,
      payload: { username: message.username || undefined, fullName: message.fullName || undefined, heartPath: heart.path, heartBatchTarget: true,
        ...(message.replyTo ? { replyTo: { messageId: message.replyTo.messageId, uid: message.replyTo.uid,
          fullName: message.replyTo.fullName, textSnippet: (message.replyTo.textSnippet ?? '').slice(0, 200) } } : {}) },
    }, { requireDurable: true, beforePersist: async attention => await currentForEffect()
      && (item.waitUntilMs === undefined || registerTelegramWaitAttention(attention, message)) });
    if (attention) dispatched++;
  }
  logger.info({ chatId, messageId: anchor.formatted.messageId, count: live.length, anchors: dispatched }, 'Telegram Heart batch evaluated');
}
