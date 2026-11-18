import { env } from '../env.js';
import { logger } from '../shared/logger.js';
import { getRedis } from '../db/redis.js';
import { isGroupAllowed } from '../allowlist/allowlist.js';
import { configFromEnv } from '../allowlist/bot-flow.js';
import { getSleepPhase } from '../tracking/sleep.js';
import { cancelWaitForScope } from '../pipeline/timing/chat-runtime.js';
import { resolveConversationScope } from '../shared/privacy-scope.js';
import { batchMessagesAnswered } from './answered.js';
import { isTelegramHeartBatchChat } from './flags.js';
import { heartRoute, hasTimedBypass } from './heart-route.js';
import { evaluateMetaHeart } from './heart-adapter.js';
import { selectHeartTargets } from './heart-targets.js';
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
    if (!hasUnansweredIntentRevision(ref)) receiptChecks.push({ chatId: item.chatId, messageId: message.messageId });
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
  const policyCurrent = async (): Promise<boolean> => {
    const config = env();
    if (!isTelegramHeartBatchChat(chatId) || heartRoute(config, chatId) !== 'heart') return false;
    const redis = getRedis();
    return await isGroupAllowed(redis, configFromEnv(config), chatId)
      && !await hasTimedBypass(chatId, true) && await getSleepPhase(undefined, true, true) === 'awake';
  };
  if (!await policyCurrent()) return;
  const live = await currentCandidates(batch);
  const anchor = live[live.length - 1];
  if (!anchor || signal.aborted || !await control.isCurrent()) return;
  const messages = live.map(item => item.formatted);
  const isCurrent = async (): Promise<boolean> => {
    if (signal.aborted || !await policyCurrent()
      || !await control.isCurrent()) return false;
    assertBatchScope(live);
    assertInputBatchCurrent(messages);
    // Re-evaluate remaining valid authors when one source changes. Throwing
    // keeps this pure attempt eligible for bounded retry; once effects started
    // the durable store records unknown and cannot repeat a partial publication.
    if ((await currentCandidates(live)).length !== live.length) throw new Error('telegram_heart_inputs_changed');
    return !signal.aborted;
  };
  const beforeEffect = async (): Promise<boolean> => await isCurrent() && await control.beginEffects() && await isCurrent();
  // Idempotent local cleanup, deliberately before effect-started: cancelling
  // the obsolete WAIT for this exact topic does not publish a reply or a new job.
  await cancelWaitForScope(chatId, anchor.formatted.messageThreadId ?? 0);
  if (!await isCurrent()) return;
  // Every distinct current source stays selectable, including unquoted
  // independent questions, with the frozen current revision of that author.
  const { anchors, currentRefs } = selectHeartTargets(live, item => item.formatted);
  const allowedTargets = anchors.map(item => item.formatted.messageId);
  const heart = await evaluateMetaHeart({ chatId, formatted: anchor.formatted, layer: anchor.layer,
    cognitiveAnchorEventId: anchor.cognitiveAnchorEventId, batchMessages: messages, targetMessageIds: allowedTargets,
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
      textPreview: (message.textContent || '').slice(0, 200), messageThreadId: message.messageThreadId,
      cognitiveAnchorEventId: item.cognitiveAnchorEventId,
      payload: { username: message.username || undefined, fullName: message.fullName || undefined, heartPath: heart.path, heartBatchTarget: true,
        ...(message.replyTo ? { replyTo: { messageId: message.replyTo.messageId, uid: message.replyTo.uid,
          fullName: message.replyTo.fullName, textSnippet: (message.replyTo.textSnippet ?? '').slice(0, 200) } } : {}) },
    }, { requireDurable: true, beforePersist: isCurrent });
    if (attention) dispatched++;
  }
  logger.info({ chatId, messageId: anchor.formatted.messageId, count: live.length, anchors: dispatched }, 'Telegram Heart batch evaluated');
}
