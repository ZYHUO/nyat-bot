// Phase 1 ConversationField projection.
//
// The field is a bounded, metadata-only view of the current conversational
// situation. It deliberately does not persist message text. Raw text can be
// inspected transiently to label a question/sticker/photo opportunity, but the
// projection only keeps coarse labels and identifiers.

import { fitGroupPace, PACE_WINDOW } from '../pipeline/rhythm/group-pace.js';
import { buildSocialGraph, type SocialGraphEdge } from './social-event-graph.js';
import { getFloorStats, type FloorStats } from '../pipeline/floor/store.js';
import { getSocialNeed } from '../tracking/social-needs.js';
import type { FormattedMessage } from '../shared/types.js';
import type { CognitiveScope } from '../shared/cognitive-scope.js';
import type { InnerState } from './nyatos-contracts.js';

export type BotPresence = 'absent' | 'lurking' | 'engaged' | 'waiting' | 'returning';

export interface ConversationField {
  schema: 'conversation_field.v1';
  scope: CognitiveScope & { visibility: 'chat'; chatId: number };
  asOf: number;
  activeTopics: string[];
  addresseeEdges: Array<{ from: number; to: number | 'group'; confidence: number }>;
  floorOwner?: number;
  temperature: number;
  density: number;
  unresolvedQuestions: string[];
  waitingBids: string[];
  mediaOpportunities: string[];
  memberNeeds: Array<{ userId: number; need: string; confidence: number }>;
  botPresence: BotPresence;
  messageCount: number;
  uniqueHumanCount: number;
  messagesLastMinute: number;
  groupPaceSec: number;
  botSocialNeed: number;
  floorStats?: FloorStats;
  asOfEventId?: string;
}

function clamp(value: number, min = 0, max = 1): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function textOf(message: FormattedMessage): string {
  return message.textContent || message.captionContent || '';
}

function asksQuestion(message: FormattedMessage | undefined): boolean {
  if (!message) return false;
  const text = textOf(message).trim();
  return text.endsWith('?') || text.endsWith('？');
}

function isHuman(message: FormattedMessage): boolean {
  return !message.isBot && message.role !== 'assistant';
}

function mergeAddresseeEdges(
  edges: Array<{ from: number; to: number | 'group'; confidence: number }>,
): Array<{ from: number; to: number | 'group'; confidence: number }> {
  const merged = new Map<string, { from: number; to: number | 'group'; confidence: number; count: number }>();
  for (const edge of edges) {
    const key = `${edge.from}:${edge.to}`;
    const current = merged.get(key) ?? { ...edge, count: 0 };
    current.count += 1;
    current.confidence = Math.max(current.confidence, edge.confidence);
    merged.set(key, current);
  }
  return Array.from(merged.values())
    .sort((a, b) => b.confidence + Math.min(0.15, b.count * 0.03) - (a.confidence + Math.min(0.15, a.count * 0.03)))
    .slice(0, 12)
    .map(({ from, to, confidence, count }) => ({
      from,
      to,
      confidence: Number(clamp(confidence + Math.min(0.15, count * 0.03)).toFixed(4)),
    }));
}

function socialEdgesToFieldEdges(edges: SocialGraphEdge[]): Array<{ from: number; to: number | 'group'; confidence: number }> {
  return edges.slice(0, 12).map((edge) => ({
    from: edge.fromUid,
    to: edge.toUid,
    confidence: Number(clamp(Math.max(0.2, edge.weight / Math.max(1, edge.interactionCount))).toFixed(4)),
  }));
}

/**
 * Pure projection for tests and replay. The caller supplies all observations;
 * this function performs no I/O and does not mutate its inputs.
 */
export function buildConversationField(input: {
  chatId: number;
  recent: FormattedMessage[];
  botUid: number;
  nowSec?: number;
  threadId?: number;
  groupPaceSec?: number;
  botSocialNeed?: number;
  socialEdges?: SocialGraphEdge[];
  floorStats?: FloorStats;
  botAddressed?: boolean;
  asOfEventId?: string;
}): ConversationField {
  const now = Number.isSafeInteger(input.nowSec) && (input.nowSec ?? 0) > 0
    ? input.nowSec!
    : Math.floor(Date.now() / 1000);
  const recent = input.recent
    .filter((message) => Number.isSafeInteger(message.timestamp) && message.timestamp > 0)
    .slice(-Math.max(PACE_WINDOW, 30));
  const humans = recent.filter(isHuman);
  const uniqueHumanCount = new Set(humans.map((message) => message.uid).filter((uid) => uid > 0)).size;
  const messagesLastMinute = humans.filter((message) => message.timestamp >= now - 60).length;
  const density = clamp(messagesLastMinute / 10);
  const groupPaceSec = Number.isFinite(input.groupPaceSec) && (input.groupPaceSec ?? 0) > 0
    ? clamp(input.groupPaceSec!, 0.8, 20)
    : fitGroupPace(recent.map((message) => message.timestamp), messagesLastMinute);
  const botSocialNeed = clamp(input.botSocialNeed ?? 0.7);
  const paceHeat = clamp((5 - groupPaceSec) / 5);
  const temperature = Number(clamp(density * 0.5 + paceHeat * 0.25 + clamp(uniqueHumanCount / 5) * 0.15 + botSocialNeed * 0.1).toFixed(4));

  const lastHuman = [...humans].reverse().find((message) => message.uid > 0);
  const latestQuestion = [...humans].reverse().find((message) => asksQuestion(message));
  const lastHumanIndex = lastHuman ? recent.lastIndexOf(lastHuman) : -1;
  const lastBotIndex = (() => {
    for (let i = recent.length - 1; i >= 0; i--) {
      const message = recent[i]!;
      if (message.uid === input.botUid || message.role === 'assistant') return i;
    }
    return -1;
  })();
  const lastBot = lastBotIndex >= 0 ? recent[lastBotIndex] : undefined;
  const distanceFromBot = lastBotIndex >= 0 ? recent.length - 1 - lastBotIndex : Number.POSITIVE_INFINITY;
  const humanAfterBot = lastBotIndex >= 0 && lastHumanIndex > lastBotIndex;
  let botPresence: BotPresence;
  if (recent.length === 0 || lastBotIndex < 0) {
    botPresence = 'lurking';
  } else if (asksQuestion(lastBot) && distanceFromBot <= 4) {
    botPresence = 'waiting';
  } else if (distanceFromBot <= 3) {
    botPresence = 'engaged';
  } else if (humanAfterBot && now - lastBot!.timestamp >= 20 * 60) {
    botPresence = 'returning';
  } else {
    botPresence = 'lurking';
  }

  const recentEdges = recent.slice(-12).flatMap((message) => {
    if (!isHuman(message) || !(message.uid > 0)) return [];
    if (message.replyTo?.uid) {
      return [{ from: message.uid, to: message.replyTo.uid > 0 ? message.replyTo.uid : 'group' as const, confidence: 0.9 }];
    }
    const text = textOf(message);
    if (/@[A-Za-z0-9_]+/.test(text)) {
      return [{ from: message.uid, to: 'group' as const, confidence: 0.45 }];
    }
    return [];
  });
  const addresseeEdges = mergeAddresseeEdges([
    ...recentEdges,
    ...socialEdgesToFieldEdges(input.socialEdges ?? []),
  ]);

  const unresolvedQuestions: string[] = [];
  const waitingBids: string[] = [];
  if (latestQuestion) unresolvedQuestions.push('latest_user_question');
  if (lastBot && asksQuestion(lastBot)) {
    waitingBids.push(humanAfterBot ? 'bot_question_pending' : 'bot_question_waiting');
  }
  if (input.botAddressed && lastHuman) waitingBids.push('latest_user_bid');

  const mediaOpportunities: string[] = [];
  const latest = recent.at(-1);
  if (latest?.sticker) mediaOpportunities.push('sticker_context');
  if (latest?.imageFileId) mediaOpportunities.push('inbound_photo');
  if (latest?.voiceFileId || latest?.audioFileId) mediaOpportunities.push('inbound_voice');
  if (latest?.documentFileId) mediaOpportunities.push('inbound_document');

  const lastHumanUid = lastHuman?.uid;
  const memberNeeds: Array<{ userId: number; need: string; confidence: number }> = [];
  if (input.botAddressed && lastHumanUid !== undefined && lastHumanUid > 0) {
    memberNeeds.push({ userId: lastHumanUid, need: 'feedback', confidence: 0.65 });
  } else if (lastHuman?.replyTo?.uid && lastHumanUid !== undefined && lastHumanUid > 0) {
    memberNeeds.push({ userId: lastHumanUid, need: 'company', confidence: 0.4 });
  }

  return {
    schema: 'conversation_field.v1',
    scope: { visibility: 'chat', chatId: input.chatId },
    asOf: now,
    activeTopics: [],
    addresseeEdges,
    ...(lastHumanUid !== undefined && lastHumanUid > 0 ? { floorOwner: lastHumanUid } : {}),
    temperature,
    density: Number(density.toFixed(4)),
    unresolvedQuestions: unresolvedQuestions.slice(0, 8),
    waitingBids: waitingBids.slice(0, 8),
    mediaOpportunities: mediaOpportunities.slice(0, 8),
    memberNeeds: memberNeeds.slice(0, 8),
    botPresence,
    messageCount: recent.length,
    uniqueHumanCount,
    messagesLastMinute,
    groupPaceSec: Number(groupPaceSec.toFixed(4)),
    botSocialNeed: Number(botSocialNeed.toFixed(4)),
    ...(input.floorStats ? { floorStats: input.floorStats } : {}),
    ...(input.asOfEventId ? { asOfEventId: input.asOfEventId } : {}),
  };
}

/** Derive a small host-owned inner-state register from the current field. */
export function deriveInnerStateFromConversationField(
  field: ConversationField,
  nowSec = field.asOf,
): InnerState {
  const unresolvedCount = field.unresolvedQuestions.length + field.waitingBids.length;
  const hasKnownAddressee = field.addresseeEdges.length > 0;
  const attention = clamp(0.3 + field.temperature * 0.55 + Math.min(0.15, unresolvedCount * 0.04));
  const energy = clamp(0.7 - field.botSocialNeed * 0.2 + clamp((20 - field.groupPaceSec) / 20) * 0.15);
  const curiosity = clamp(0.2 + Math.min(0.45, unresolvedCount * 0.12) + Math.min(0.2, field.mediaOpportunities.length * 0.05));
  const connection = clamp(0.45 + field.temperature * 0.25 + (1 - field.botSocialNeed) * 0.2);
  const confidence = clamp(0.35 + (hasKnownAddressee ? 0.2 : 0) + (field.floorOwner ? 0.1 : 0));
  const uncertainty = clamp(0.25 + (hasKnownAddressee ? 0 : 0.2) + Math.min(0.25, unresolvedCount * 0.05));
  const unresolved = [
    ...(field.unresolvedQuestions.length > 0 ? ['latest_user_question'] : []),
    ...field.waitingBids.slice(0, 3),
  ].slice(0, 8);
  const wants = [
    ...(field.botSocialNeed >= 0.7 ? ['company'] : []),
    ...(field.unresolvedQuestions.length > 0 ? ['understanding'] : []),
    ...(field.mediaOpportunities.length > 0 ? ['expression'] : []),
  ].slice(0, 8);
  const currentNeed = field.unresolvedQuestions.length > 0
    ? 'feedback'
    : field.botSocialNeed >= 0.75
      ? 'company'
      : field.temperature >= 0.65
        ? 'witness'
        : undefined;
  return {
    schema: 'inner_state.v1',
    attention: Number(attention.toFixed(4)),
    energy: Number(energy.toFixed(4)),
    curiosity: Number(curiosity.toFixed(4)),
    connection: Number(connection.toFixed(4)),
    confidence: Number(confidence.toFixed(4)),
    uncertainty: Number(uncertainty.toFixed(4)),
    unresolved,
    wants,
    aversions: [],
    commitments: [],
    ...(currentNeed ? { currentNeed } : {}),
    updatedAt: Number.isSafeInteger(nowSec) && nowSec > 0 ? nowSec : Math.floor(Date.now() / 1000),
  };
}

/** Collect bounded observations used by the shadow proposal. */
export async function collectConversationField(input: {
  chatId: number;
  recent: FormattedMessage[];
  botUid: number;
  nowSec?: number;
  threadId?: number;
  botAddressed?: boolean;
  asOfEventId?: string;
}): Promise<ConversationField> {
  const now = input.nowSec ?? Math.floor(Date.now() / 1000);
  const messagesLastMinute = input.recent.filter((message) => isHuman(message) && message.timestamp >= now - 60).length;
  const groupPaceSec = fitGroupPace(input.recent.map((message) => message.timestamp), messagesLastMinute);

  let botSocialNeed = 0.7;
  try {
    botSocialNeed = await getSocialNeed(input.chatId);
  } catch { /* keep the neutral default when Redis is unavailable */ }

  let socialEdges: SocialGraphEdge[] = [];
  try {
    socialEdges = buildSocialGraph({ chatId: input.chatId, limit: 160, maxEdges: 24, nowSec: now }).edges;
  } catch { /* the recent-message projection remains usable without the graph */ }

  let floorStats: FloorStats | undefined;
  try {
    floorStats = getFloorStats(input.chatId, 1);
  } catch { /* optional context only */ }

  return buildConversationField({
    chatId: input.chatId,
    recent: input.recent,
    botUid: input.botUid,
    nowSec: now,
    ...(input.threadId ? { threadId: input.threadId } : {}),
    groupPaceSec,
    botSocialNeed,
    socialEdges,
    ...(floorStats ? { floorStats } : {}),
    ...(input.botAddressed !== undefined ? { botAddressed: input.botAddressed } : {}),
    ...(input.asOfEventId ? { asOfEventId: input.asOfEventId } : {}),
  });
}
