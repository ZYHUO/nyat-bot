// Host projections of recorded observations. Reading a prompt is not a new
// experience: the source event is the idempotency boundary, across restarts.
import { env } from '../env.js';
import { getDb } from '../db/sqlite.js';
import { resolveConversationScope } from '../shared/privacy-scope.js';
import { scopeKey } from '../shared/cognitive-scope.js';
import type { MessageEventIdentity } from '../shared/event-identity.js';
import { findConversationRef, isPlatformInternalId } from '../platform/identity-store.js';
import { getCognitiveEvent } from './cognitive-events.js';
import { buildConversationField, deriveInnerStateFromConversationField, type ConversationField } from './conversation-field.js';
import { getLatestInnerState, recordInnerState, type NyatosStateRecord } from './nyatos-state.js';
import { parseInnerState, type InnerState } from './nyatos-contracts.js';
import { hasCurrentProcessWakeSource } from './cognitive-continuity.js';

export function hasCurrentEmotionSource(chatId: number, value: unknown): value is MessageEventIdentity {
  if (!value || typeof value !== 'object') return false;
  const identity = value as Partial<MessageEventIdentity>;
  const conversation = identity.ref?.conversation;
  const target = resolveConversationScope(chatId);
  if (!target?.accountId || !conversation || conversation.platform !== target.platform
    || conversation.accountId !== target.accountId || conversation.conversationKind !== target.conversationKind) return false;
  const rawId = isPlatformInternalId(chatId) ? findConversationRef(chatId)?.id : String(chatId);
  return conversation.id === rawId && typeof identity.eventId === 'string' && identity.eventId.length > 0;
}

function priorProjection(field: Pick<ConversationField, 'scope'>, cause: string): NyatosStateRecord<InnerState> | null {
  const row = getDb().prepare('SELECT id FROM cognitive_events WHERE dedupe_key = ?')
    .get(`inner-state:${scopeKey(field.scope)}:${cause}`) as { id: string } | undefined;
  if (!row) return null;
  const event = getCognitiveEvent(row.id);
  const target = resolveConversationScope(field.scope.chatId);
  if (!target?.accountId || JSON.stringify(event?.fact['conversationScope']) !== JSON.stringify(target)) return null;
  const value = event ? parseInnerState(event.fact['value']) : null;
  return event && value ? { eventId: event.id, scopeKey: event.scopeKey, occurredAt: event.occurredAt, value, source: event.source } : null;
}

/** Synchronous transaction: no await between reading the prior and recording the next state. */
export function projectInnerStateFromConversationField(
  field: ConversationField,
  options: { causationId?: string } = {},
): NyatosStateRecord<InnerState> | null {
  if (!env().EMOTION_CONTINUITY_ENABLED || !resolveConversationScope(field.scope.chatId)?.accountId) return null;
  const cause = options.causationId ?? field.asOfEventId;
  // No caller may mint an experience just by asking to render a prompt.
  if (!cause) return null;
  const evidence = getCognitiveEvent(cause);
  if (!evidence || evidence.chatId !== field.scope.chatId || evidence.source === 'model') return null;
  if (['message_received', 'message_edited'].includes(evidence.type)) {
    if (!hasCurrentEmotionSource(field.scope.chatId, evidence.fact['eventIdentity'])) return null;
  } else if (!hasCurrentProcessWakeSource(evidence)) return null;
  return getDb().transaction(() => {
    const existing = priorProjection(field, cause);
    if (existing) return existing;
    const prior = getLatestInnerState(field.scope, field.asOf);
    const state = deriveInnerStateFromConversationField(field, field.asOf, prior?.value);
    const recorded = recordInnerState(state, { scope: field.scope, causationId: cause, occurredAt: field.asOf });
    return recorded ? priorProjection(field, cause) : null;
  }).immediate();
}

/** Meta's real workspace path: one projection per authenticated inbound event. */
export async function observeInnerStateForEvent(chatId: number, eventId: string): Promise<NyatosStateRecord<InnerState> | null> {
  if (!env().EMOTION_CONTINUITY_ENABLED) return null;
  const anchor = getCognitiveEvent(eventId);
  if (!anchor || anchor.chatId !== chatId || anchor.source === 'model'
    || anchor.occurredAt > Math.floor(Date.now() / 1000) + 60
    || !['message_received', 'message_edited'].includes(anchor.type)
    || !hasCurrentEmotionSource(chatId, anchor.fact['eventIdentity'])) return null;
  const identity = anchor.fact['eventIdentity'];
  const scope = { visibility: 'chat' as const, chatId };
  const existing = priorProjection({ scope }, anchor.id);
  if (existing) return existing;
  const { getRecent } = await import('../pipeline/context/manager.js');
  const { getBotIdentity } = await import('../bot/bot.js');
  const recent = (await getRecent(chatId, 30)).filter((message) => {
    const source = message.eventIdentity;
    return hasCurrentEmotionSource(chatId, source) && source.receivedAt <= identity.receivedAt
      && message.timestamp <= anchor.occurredAt
      && (message.timestamp >= anchor.occurredAt - 3600 || source.eventId === identity.eventId);
  });
  if (!recent.some((message) => message.eventIdentity?.eventId === identity.eventId)) return null;
  const field = buildConversationField({ chatId, recent, botUid: getBotIdentity(chatId).uid,
    nowSec: anchor.occurredAt, asOfEventId: anchor.id, botAddressed: chatId > 0 });
  return projectInnerStateFromConversationField(field, { causationId: anchor.id });
}

/** A small read-only hint; stale numeric states relax without inventing events. */
export function getInnerStateTendencies(chatId: number): string[] {
  if (!env().EMOTION_CONTINUITY_ENABLED) return [];
  try {
    const state = getLatestInnerState({ visibility: 'chat', chatId })?.value;
    if (!state) return [];
    const elapsed = Math.max(0, Math.floor(Date.now() / 1000) - state.updatedAt);
    const retained = Math.exp(-elapsed / (6 * 3600));
    const choices: Array<{ weight: number; text: string }> = [];
    if (state.commitments.length) choices.push({ weight: 0.65, text: '你还记得有答应过的事尚未明确完成，遇到相关话题会留心' });
    if (state.aversions.length) choices.push({ weight: 0.45, text: '你有一些已经记下的边界，不必为了迎合而勉强自己' });
    if (state.curiosity * retained > 0.4) choices.push({ weight: state.curiosity * retained, text: '你对刚才的话题还留着一点好奇，愿意沿着具体细节继续想' });
    if (state.uncertainty * retained > 0.4) choices.push({ weight: state.uncertainty * retained, text: '你还没有完全想明白，愿意先确认事实，不急着装作有答案' });
    if ((1 - state.energy) * retained > 0.55) choices.push({ weight: (1 - state.energy) * retained, text: '你现在更想放慢节奏，把眼前的一件事说清楚' });
    return choices.sort((a, b) => b.weight - a.weight).slice(0, 2).map((item) => item.text);
  } catch { return []; }
}
