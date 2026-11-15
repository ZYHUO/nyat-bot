import { env } from '../env.js';
import { logger } from '../shared/logger.js';
import { evaluateMetaHeart } from './heart-adapter.js';
import { getAttentionAccumulator } from './index.js';
import type { QqHeartCandidate } from './qq-heart-batch.js';
import { isMetaSubagentChat } from './flags.js';
import { metaMuteBlocksReply } from './ingress-intercepts.js';
import { isInFlightCodeActForUser } from './speaker-burst.js';

/** Reusable decision boundary: no commands, intake counters, or media conversion
 * are repeated when recovering a never-started durable QQ candidate. */
export async function processQqHeartBatch(batch: QqHeartCandidate[], signal: AbortSignal,
  note?: (outcome: 'spoke' | 'silent' | 'wait') => void): Promise<void> {
  if (env().DURABLE_INGRESS_ENABLED) {
    if (batch.some(item => !isMetaSubagentChat(item.chatId))) throw new Error('qq_batch_activation_changed');
    batch = batch.filter(item => !metaMuteBlocksReply(item.chatId, item.formatted, item.addressed))
      .map(item => ({ ...item, ongoingFollowup: !!item.ongoingFollowup && isInFlightCodeActForUser(item.chatId, item.formatted.uid) }));
  }
  const anchor = batch[batch.length - 1];
  if (!anchor || signal.aborted) return;
  const chatId = anchor.chatId;
  if (batch.some(item => item.chatId !== chatId)) throw new Error('cross_chat_heart_batch');
  const direct = batch.some(item => item.addressed);
  const ongoingFollowup = !direct && batch.some(item => item.ongoingFollowup);
  const heart = await evaluateMetaHeart({ chatId, formatted: anchor.formatted, layer: anchor.layer,
    cognitiveAnchorEventId: anchor.cognitiveAnchorEventId, addressed: direct || ongoingFollowup,
    ongoingFollowup, batchMessages: batch.map(item => item.formatted), signal });
  if (signal.aborted) throw new Error('heart_batch_aborted');
  if (heart.verdict !== 'allow') {
    note?.(heart.reason?.startsWith('heart_wait') ? 'wait' : 'silent');
    return;
  }
  note?.('spoke');
  const pressure = (heart.layer === 'L0' ? 100 : heart.layer === 'L1' ? 70 : 30) + (heart.pressureBoost ?? 0);
  for (const item of batch) {
    if (signal.aborted) throw new Error('heart_batch_aborted');
    const message = item.formatted;
    await getAttentionAccumulator().ingestAsync({ pendingIntent: message.pendingIntent, chatId, layer: heart.layer, reason: heart.reason,
      messageId: message.messageId, userId: message.uid, textPreview: (message.textContent || '').slice(0, 200),
      pressure, messageThreadId: message.messageThreadId, cognitiveAnchorEventId: item.cognitiveAnchorEventId,
      payload: { username: message.username || undefined, fullName: message.fullName || undefined, heartPath: heart.path,
        ...(message.replyTo ? { replyTo: { messageId: message.replyTo.messageId, uid: message.replyTo.uid,
          fullName: message.replyTo.fullName, textSnippet: (message.replyTo.textSnippet ?? '').slice(0, 200) } } : {}) },
    }, { requireDurable: env().DURABLE_INGRESS_ENABLED });
  }
  logger.info({ chatId, messageId: anchor.formatted.messageId, count: batch.length, layer: heart.layer }, 'Meta attention ingested (heart)');
}
