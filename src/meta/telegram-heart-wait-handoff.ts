import { telegramHeartBatchPolicyCurrent } from './telegram-heart-policy.js';
import { getDb } from '../db/sqlite.js';
import { env } from '../env.js';
import { incrCounter } from '../metrics/registry.js';
import { getChatState } from '../pipeline/timing/chat-runtime.js';
import { canonicalJson, eventHash } from '../shared/event-identity.js';
import { resolveConversationScope } from '../shared/privacy-scope.js';
import type { FormattedMessage } from '../shared/types.js';
import { checkCodeActActivation } from '../subagent/activation-policy.js';
import { isMessageAnswered } from './answered.js';
import { isTelegramHeartBatchChat } from './flags.js';
import { telegramHeartPhysicalBodyHash, telegramHeartWaitContext } from './heart-source-fingerprint.js';
import { inspectPendingIntent, pendingIntentForEvent } from './pending-intent.js';
import { getTelegramHeartEntry, hasTelegramHeartCapacity, telegramHeartScopeKey, telegramHeartTransaction } from './telegram-heart-store.js';
import type { TelegramHeartCandidate } from './telegram-heart-store.js';
import type { AttentionItem, AttentionLayer } from './types.js';
import { isTaskWaitRecoveryCurrent } from './wait-recovery-fence.js';

interface Receipt {
  state: string; scope_key: string; received_at_ms: number;
  wait_attention_key: string | null; wait_source_hash: string | null; wait_source_layer: AttentionLayer | null;
  wait_attention_entered: number; wait_redriven: number; version: number; cancel_version: number;
}

function readReceipt(item: AttentionItem): Receipt | undefined {
  const fence = item.waitRecovery, event = item.telegramWaitSourceEventId;
  if (fence?.authority !== 'telegram_source' || fence.platform !== 'telegram' || !event || !/^[a-f0-9]{64}$/.test(event)
    || !item.messageId || !item.userId || item.chatId !== fence.chatId || (item.messageThreadId ?? 0) !== fence.threadId
    || !Number.isSafeInteger(fence.expiresAt) || fence.expiresAt <= Date.now() || fence.expiresAt - Date.now() > 300_000
    || !env().TIMING_GATE_ENABLED || !isTelegramHeartBatchChat(item.chatId)
    || env().META_ACTIVATED_AT_SEC !== fence.activationEpoch || !checkCodeActActivation(item).allowed) return;
  const scope = resolveConversationScope(item.chatId);
  if (scope?.platform !== 'telegram' || scope.conversationKind !== 'group' || scope.accountId !== fence.accountId) return;
  return getDb().prepare(`SELECT c.state,c.scope_key,c.received_at_ms,c.wait_attention_key,
    c.wait_source_hash,c.wait_source_layer,c.wait_attention_entered,c.wait_redriven,s.version,s.cancel_version
    FROM telegram_heart_candidates c JOIN telegram_heart_scope_versions s USING(scope_key)
    WHERE event_id=? AND c.scope_key=? AND c.wait_until_ms IS NOT NULL AND c.state IN ('evaluating','settled')`)
    .get(event, telegramHeartScopeKey(fence.accountId, item.chatId, fence.threadId)) as Receipt | undefined;
}

/** Bind only host fields. A copy cannot change its source, revision or authority.
 * A direct interrupt changes cancel_version even if passive input arrives later. */
function receiptKey(item: AttentionItem, row: Receipt): string {
  return eventHash(canonicalJson([item, row.cancel_version]));
}

/** Called after the producer's generation and effect checks, immediately before its Redis push. */
export function registerTelegramWaitAttention(item: AttentionItem, source: FormattedMessage): boolean {
  return telegramHeartTransaction(() => {
    const row = readReceipt(item), event = item.telegramWaitSourceEventId;
    if (!row || row.state !== 'evaluating' || !event || item.waitRecovery?.generation !== `tg-source-${row.version}`
      || source.eventIdentity?.eventId !== event || source.messageId !== item.messageId || source.uid !== item.userId) return false;
    const original = getTelegramHeartEntry(event)?.item;
    const hash = telegramHeartPhysicalBodyHash(source);
    if (!original || original.addressed || telegramHeartPhysicalBodyHash(original.formatted) !== hash) return false;
    return getDb().prepare(`UPDATE telegram_heart_candidates SET wait_attention_key=?,wait_source_hash=?,wait_source_layer=?
      WHERE event_id=? AND state='evaluating' AND wait_attention_key IS NULL AND wait_attention_entered=0`)
      .run(receiptKey(item, row), hash, original.layer, event).changes === 1;
  });
}

function retired(reason: string): false {
  incrCounter('telegram_heart_wait_handoffs_total', { reason });
  return false;
}

function recoverable(item: AttentionItem, row: Receipt): boolean {
  const fence = item.waitRecovery!;
  const match = /^tg-source-([1-9]\d*)$/.exec(fence.generation);
  return !!match && row.version > Number(match[1]) && row.state === 'settled' && !row.wait_redriven
    && !row.wait_attention_entered && row.wait_attention_key === receiptKey(item, row)
    && Date.now() - row.received_at_ms <= 300_000;
}

/** Never publish an old decision. A stale, unentered Redis ticket may restore its
 * exact physical source to the bounded WAIT queue once. A Meta session marks the
 * same ticket entered before diary, model or dispatch work. Busy requeue retains
 * its ordinary semantics while current, but cannot acquire a new evaluation. */
export async function checkTelegramWaitAttention(item: AttentionItem, enterSession: boolean): Promise<boolean> {
  try {
    const current = await isTaskWaitRecoveryCurrent(item);
    let row = readReceipt(item);
    if (!row || row.wait_attention_key !== receiptKey(item, row)) return retired('unbound_or_revoked');
    if (current && item.waitRecovery!.generation === `tg-source-${row.version}`) {
      if (!enterSession) return true;
      // One writer transaction linearizes session entry against a concurrent revival.
      const entered = telegramHeartTransaction(() => {
        const latest = readReceipt(item);
        if (!latest || latest.wait_attention_key !== receiptKey(item, latest)
          || item.waitRecovery!.generation !== `tg-source-${latest.version}`) return false;
        if (latest.wait_attention_entered) return true;
        return getDb().prepare('UPDATE telegram_heart_candidates SET wait_attention_entered=1 WHERE event_id=? AND wait_attention_key=?')
          .run(item.telegramWaitSourceEventId, latest.wait_attention_key).changes === 1;
      });
      if (entered) return true;
      // A separate process may have observed passive input just before the lock.
      row = readReceipt(item);
      if (!row) return retired('unbound_or_revoked');
    }
    if (!recoverable(item, row)) return retired('closed_or_already_used');
    const { chatId, messageId, userId, telegramWaitSourceEventId: event } = item;
    if (!await telegramHeartBatchPolicyCurrent(chatId) || (await getChatState(chatId, true)).state !== 'RUNNING'
      || await isMessageAnswered(chatId, messageId!, true)) return retired('policy_or_answered');
    const history = await telegramHeartWaitContext(chatId, item.messageThreadId ?? 0);
    const source = history.find(message => message.messageId === messageId);
    if (!source || source.uid !== userId || source.role !== 'user' || source.isBot || source.isAnonymous
      || source.eventIdentity?.eventId !== event || telegramHeartPhysicalBodyHash(source) !== row.wait_source_hash) return retired('source_changed');

    const restored = telegramHeartTransaction(() => {
      const latest = readReceipt(item);
      if (!latest || !recoverable(item, latest) || !latest.wait_source_layer || !hasTelegramHeartCapacity(latest.scope_key)) return false;
      const ref = pendingIntentForEvent(event);
      if (!ref || canonicalJson(ref) !== canonicalJson(item.pendingIntent) || ref.senderId !== source.uid || ref.chatId !== chatId
        || ref.accountId !== item.waitRecovery!.accountId || ref.threadId !== (item.messageThreadId ?? 0)) return false;
      const intent = inspectPendingIntent(ref);
      if (intent.state !== 'pending' || intent.currentRevision !== ref.revision) return false;
      const candidate: TelegramHeartCandidate = { chatId, formatted: { ...source, pendingIntent: ref },
        layer: latest.wait_source_layer, addressed: false, cognitiveAnchorEventId: item.cognitiveAnchorEventId };
      return getDb().prepare(`UPDATE telegram_heart_candidates SET state='pending',attempts=0,owner=NULL,
        payload_json=?,reason='wait_attention_recheck',wait_until_ms=MIN(wait_until_ms,?),reviewed_early=1,
        wait_attention_key=NULL,wait_source_hash=NULL,wait_source_layer=NULL,wait_redriven=1
        WHERE event_id=? AND state='settled' AND wait_redriven=0 AND wait_attention_entered=0 AND wait_attention_key=?`)
        .run(canonicalJson(candidate), Date.now(), event, latest.wait_attention_key).changes === 1;
    });
    return retired(restored ? 'source_requeued' : 'source_ineligible');
  } catch { return retired('authority_unavailable'); }
}
