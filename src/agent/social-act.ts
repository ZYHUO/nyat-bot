// Phase 1 SocialAct shadow contract.
//
// The adapter records the action selected by the existing judge, the bounded
// ConversationField it saw, a conservative capability snapshot, and the real
// delivery outcome. It never copies user text, model reasoning, or grants any
// execution authority. A later model-owned proposal can use the same contract;
// the host-owned event and dedupe boundary stays identical.

import { z } from 'zod';
import { appendCognitiveEvent, listCognitiveEvents } from './cognitive-events.js';
import type { CognitiveEvent } from './cognitive-events.js';
import {
  buildHostCapabilitySnapshot,
  capabilitySnapshotSchema,
  innerStateSchema,
  missionProposalSchema,
  type CapabilitySnapshot,
  type InnerState,
} from './nyatos-contracts.js';
import type { ConversationField } from './conversation-field.js';
import type { FormattedMessage, JudgeResult } from '../shared/types.js';
import { scopeKey } from '../shared/cognitive-scope.js';
import { compileSocialActProposal } from './social-act-compiler.js';

export const socialActIntentSchema = z.enum([
  'answer',
  'join',
  'ask',
  'share',
  'witness',
  'challenge',
  'repair',
  'observe',
  'pause',
]);
export type SocialActIntent = z.infer<typeof socialActIntentSchema>;

export const socialActMediaSchema = z.object({
  kind: z.enum(['photo', 'sticker', 'voice', 'document', 'poll', 'link']),
  source: z.string().trim().min(1).max(240),
  purpose: z.enum(['explain', 'prove', 'tease', 'comfort', 'celebrate', 'shift', 'repair']),
}).strict();
export type SocialActMedia = z.infer<typeof socialActMediaSchema>;

export const socialActBubbleSchema = z.object({
  text: z.string().min(1).max(4096),
  pauseAfterMs: z.number().int().min(0).max(10 * 60_000).optional(),
  replyToMessageId: z.number().int().positive().optional(),
}).strict();
export type SocialActBubble = z.infer<typeof socialActBubbleSchema>;

const conversationFieldSchema = z.object({
  schema: z.literal('conversation_field.v1'),
  scope: z.object({
    visibility: z.literal('chat'),
    chatId: z.number().int().refine((value) => value !== 0, 'chatId must be non-zero'),
    userId: z.number().int().positive().optional(),
    taskId: z.string().trim().min(1).max(160).optional(),
  }).strict(),
  asOf: z.number().int().positive(),
  activeTopics: z.array(z.string().trim().min(1).max(160)).max(16),
  addresseeEdges: z.array(z.object({
    from: z.number().int().positive(),
    to: z.union([z.number().int().positive(), z.literal('group')]),
    confidence: z.number().min(0).max(1),
  }).strict()).max(16),
  floorOwner: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(1),
  density: z.number().min(0).max(1),
  unresolvedQuestions: z.array(z.string().trim().min(1).max(160)).max(16),
  waitingBids: z.array(z.string().trim().min(1).max(160)).max(16),
  mediaOpportunities: z.array(z.string().trim().min(1).max(160)).max(16),
  memberNeeds: z.array(z.object({
    userId: z.number().int().positive(),
    need: z.string().trim().min(1).max(80),
    confidence: z.number().min(0).max(1),
  }).strict()).max(16),
  botPresence: z.enum(['absent', 'lurking', 'engaged', 'waiting', 'returning']),
  messageCount: z.number().int().min(0).max(1000),
  uniqueHumanCount: z.number().int().min(0).max(1000),
  messagesLastMinute: z.number().int().min(0).max(1000),
  groupPaceSec: z.number().min(0).max(120),
  botSocialNeed: z.number().min(0).max(1),
  floorStats: z.object({
    total: z.number().int().min(0),
    to_me: z.number().int().min(0),
    to_other: z.number().int().min(0),
    ambient: z.number().int().min(0),
    not_me: z.number().int().min(0),
  }).strict().optional(),
  asOfEventId: z.string().trim().min(1).max(240).optional(),
}).strict();

const judgeSnapshotSchema = z.object({
  action: z.enum(['REPLY', 'IGNORE', 'REJECT']),
  level: z.enum(['L0_RULE', 'L1_MICRO', 'L2_AI']),
  replyPath: z.string().trim().min(1).max(80).optional(),
  rule: z.string().trim().min(1).max(96).optional(),
  confidence: z.number().min(0).max(1).optional(),
  latencyMs: z.number().int().min(0),
}).strict();

const metaDispatchSnapshotSchema = z.object({
  layer: z.enum(['L0', 'L1', 'L1_CALLBACK', 'L2']),
  decision: z.enum(['proposed', 'blocked', 'skipped']),
  decisionReason: z.string().trim().min(1).max(120).optional(),
  interrupt: z.boolean(),
  taskId: z.string().trim().min(1).max(160).optional(),
}).strict();

export const socialActProposalSchema = z.object({
  schema: z.literal('social_act.v1'),
  scope: z.object({
    visibility: z.literal('chat'),
    chatId: z.number().int().refine((value) => value !== 0, 'chatId must be non-zero'),
    userId: z.number().int().positive().optional(),
    taskId: z.string().trim().min(1).max(160).optional(),
  }).strict(),
  triggerEventId: z.string().trim().min(1).max(240).optional(),
  correlationId: z.string().trim().min(1).max(240),
  source: z.enum(['legacy_judge', 'model']),
  intent: socialActIntentSchema,
  targetUserId: z.number().int().positive().optional(),
  replyToMessageId: z.number().int().positive().optional(),
  /** Visible expression units only; never hidden chain-of-thought. */
  thoughtUnits: z.array(z.string().trim().min(1).max(240)).max(16),
  bubbles: z.array(socialActBubbleSchema).max(16),
  media: z.array(socialActMediaSchema).max(8),
  reaction: z.string().trim().min(1).max(32).optional(),
  typing: z.object({
    beforeMs: z.number().int().min(0).max(10 * 60_000).optional(),
    betweenMs: z.number().int().min(0).max(10 * 60_000).optional(),
  }).strict().optional(),
  followUp: z.object({
    wakeAt: z.number().int().positive(),
    reason: z.string().trim().min(1).max(240),
  }).strict().optional(),
  disclosure: z.object({
    state: z.string().trim().min(1).max(240),
    evidenceEventIds: z.array(z.string().trim().min(1).max(240)).max(32),
  }).strict().optional(),
  prediction: z.object({
    expectedEffect: z.string().trim().min(1).max(240),
    watchFor: z.array(z.string().trim().min(1).max(160)).max(8),
  }).strict().optional(),
  expectedEffect: z.string().trim().min(1).max(240).optional(),
  uncertainty: z.number().min(0).max(1).optional(),
  innerState: innerStateSchema.optional(),
  judge: judgeSnapshotSchema.optional(),
  metaDispatch: metaDispatchSnapshotSchema.optional(),
  capability: capabilitySnapshotSchema,
  conversationField: conversationFieldSchema.optional(),
  mission: missionProposalSchema.optional(),
}).strict();
export type SocialActProposal = z.infer<typeof socialActProposalSchema>;

export type SocialActOutcomeStatus = 'delivered' | 'silent' | 'blocked' | 'failed' | 'interrupted';

export const socialActOutcomeSchema = z.object({
  schema: z.literal('social_act_outcome.v1'),
  scope: z.object({
    visibility: z.literal('chat'),
    chatId: z.number().int().refine((value) => value !== 0, 'chatId must be non-zero'),
    userId: z.number().int().positive().optional(),
    taskId: z.string().trim().min(1).max(160).optional(),
  }).strict(),
  status: z.enum(['delivered', 'silent', 'blocked', 'failed', 'interrupted']),
  reason: z.string().trim().min(1).max(160).optional(),
  completedAt: z.number().int().positive(),
  plannedBubbleCount: z.number().int().min(0).max(32),
  deliveredBubbleCount: z.number().int().min(0).max(32),
  targetMessageIds: z.array(z.number().int().positive()).max(32),
  deliveredMessageIds: z.array(z.number().int().positive()).max(32),
  typingBeforeMs: z.number().int().min(0).max(10 * 60_000).optional(),
  media: z.object({
    stickers: z.number().int().min(0).max(32).default(0),
    voices: z.number().int().min(0).max(32).default(0),
    polls: z.number().int().min(0).max(32).default(0),
    reactions: z.number().int().min(0).max(32).default(0),
  }).strict(),
  observedEffects: z.object({
    canSendText: z.boolean().nullable().optional(),
    canSendMedia: z.boolean().nullable().optional(),
    canReact: z.boolean().nullable().optional(),
    canPoll: z.boolean().nullable().optional(),
    canSendSticker: z.boolean().nullable().optional(),
    canSendVoice: z.boolean().nullable().optional(),
    canDeleteOwn: z.boolean().nullable().optional(),
  }).strict().optional(),
  predictionError: z.number().min(0).max(1).optional(),
}).strict();
export type SocialActOutcome = z.infer<typeof socialActOutcomeSchema>;

export interface SocialActRecord {
  eventId: string;
  chatId: number;
  messageId: number;
  userId: number | null;
  intent: SocialActIntent;
  targetUserId: number | null;
  replyToMessageId: number | null;
  source: SocialActProposal['source'];
  triggerEventId: string | null;
  correlationId: string;
  occurredAt: number;
  judgeAction: JudgeResult['action'] | null;
  judgeLevel: JudgeResult['level'] | null;
  bubbleCount: number;
  mediaKinds: string[];
  mediaPurposes: string[];
  hasFollowUp: boolean;
  expectedEffect: string | null;
  capabilityUnknownCount: number;
  innerStateCurrentNeed: InnerState['currentNeed'] | null;
}

export interface SocialActOutcomeRecord {
  eventId: string;
  chatId: number;
  messageId: number;
  proposalEventId: string | null;
  status: SocialActOutcomeStatus;
  reason: string | null;
  occurredAt: number;
  plannedBubbleCount: number;
  deliveredBubbleCount: number;
  targetMessageIds: number[];
  deliveredMessageIds: number[];
  typingBeforeMs: number | null;
  media: { stickers: number; voices: number; polls: number; reactions: number };
  predictionError: number | null;
  replyTargetResolved: boolean | null;
}

export interface SocialActReplayReport {
  schema: 'social_act_replay.v1';
  chatId: number;
  asOf: number;
  totalProposals: number;
  totalOutcomes: number;
  missingOutcomes: number;
  orphanOutcomes: number;
  statusCounts: Record<SocialActOutcomeStatus, number>;
  intentCounts: Partial<Record<SocialActIntent, number>>;
  intentStatusCounts: Record<string, Partial<Record<SocialActOutcomeStatus, number>>>;
  delivery: {
    plannedBubbles: number;
    deliveredBubbles: number;
    multiBubbleProposals: number;
    multiBubbleDeliveries: number;
  };
  replyTargets: { expected: number; resolved: number; resolutionRate: number | null };
  mediaPurposeCounts: Record<string, number>;
  actualMediaCounts: { stickers: number; voices: number; polls: number; reactions: number };
  prediction: { eligible: number; meanError: number | null; exactRate: number | null };
  recent: Array<{
    messageId: number;
    intent: SocialActIntent;
    status: SocialActOutcomeStatus | null;
    plannedBubbles: number;
    deliveredBubbles: number;
    expectedEffect: string | null;
  }>;
}

function validChatId(value: number): boolean {
  return Number.isSafeInteger(value) && value !== 0;
}

function isChatOnlyScope(scope: { visibility: string; chatId?: number; userId?: number; taskId?: string }): boolean {
  return scope.visibility === 'chat'
    && scope.chatId !== undefined
    && validChatId(scope.chatId)
    && scope.userId === undefined
    && scope.taskId === undefined;
}

function validMessageId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function validUserId(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0;
}

function boundedText(value: string | undefined, max: number): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, max) : undefined;
}

function boundedConfidence(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return Math.min(1, Math.max(0, value));
}

function intentForJudge(action: JudgeResult['action']): SocialActIntent {
  if (action === 'REPLY') return 'answer';
  return action === 'REJECT' ? 'observe' : 'pause';
}

function parseIntent(value: unknown): SocialActIntent | null {
  // Accept the first shadow vocabulary for already-written local events.
  if (value === 'leave' || value === 'wait') return 'pause';
  const result = socialActIntentSchema.safeParse(value);
  return result.success ? result.data : null;
}

function parseStringArray(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0).slice(0, max);
}

function parseNumberArray(value: unknown, max: number): number[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is number => typeof item === 'number' && Number.isSafeInteger(item) && item > 0)
    .slice(0, max);
}

function parseOutcomeStatus(value: unknown): SocialActOutcomeStatus | null {
  return value === 'delivered' || value === 'silent' || value === 'blocked'
    || value === 'failed' || value === 'interrupted'
    ? value
    : null;
}

function unknownCapabilityCount(capability: CapabilitySnapshot): number {
  const observedUnknown = Object.values(capability.observed).filter((value) => value === null).length;
  const adminUnknown = capability.admin
    ? Object.values(capability.admin).filter((value) => value === null).length
    : 0;
  return observedUnknown + adminUnknown;
}

function boundedProposalSummary(proposal: SocialActProposal): Record<string, unknown> {
  const field = proposal.conversationField;
  const conversationField = field
    ? {
        schema: field.schema,
        scope: field.scope,
        asOf: field.asOf,
        activeTopics: field.activeTopics.slice(0, 4),
        addresseeEdges: field.addresseeEdges.slice(0, 8),
        ...(field.floorOwner === undefined ? {} : { floorOwner: field.floorOwner }),
        temperature: field.temperature,
        density: field.density,
        unresolvedQuestions: field.unresolvedQuestions.slice(0, 4),
        waitingBids: field.waitingBids.slice(0, 4),
        mediaOpportunities: field.mediaOpportunities.slice(0, 6),
        memberNeeds: field.memberNeeds.slice(0, 6),
        botPresence: field.botPresence,
        messageCount: field.messageCount,
        uniqueHumanCount: field.uniqueHumanCount,
        messagesLastMinute: field.messagesLastMinute,
        groupPaceSec: field.groupPaceSec,
        botSocialNeed: field.botSocialNeed,
        ...(field.floorStats ? { floorStats: field.floorStats } : {}),
        ...(field.asOfEventId ? { asOfEventId: field.asOfEventId } : {}),
      }
    : null;
  const mission = proposal.mission
    ? {
        schema: proposal.mission.schema,
        scope: proposal.mission.scope,
        status: proposal.mission.status,
        successCheckCount: proposal.mission.successChecks.length,
        watchForCount: proposal.mission.watchFor.length,
        maxAttempts: proposal.mission.budget.maxAttempts,
        maxWallClockSec: proposal.mission.budget.maxWallClockSec,
      }
    : null;
  const innerState = proposal.innerState
    ? {
        schema: proposal.innerState.schema,
        attention: proposal.innerState.attention,
        energy: proposal.innerState.energy,
        curiosity: proposal.innerState.curiosity,
        connection: proposal.innerState.connection,
        confidence: proposal.innerState.confidence,
        uncertainty: proposal.innerState.uncertainty,
        currentNeed: proposal.innerState.currentNeed ?? null,
        unresolvedCount: proposal.innerState.unresolved.length,
        wants: proposal.innerState.wants.slice(0, 4),
      }
    : null;
  return {
    schema: proposal.capability.schema,
    chatKind: proposal.capability.chatKind,
    threadId: proposal.capability.threadId ?? null,
    transport: proposal.capability.transport,
    observed: proposal.capability.observed,
    ...(proposal.capability.admin ? { admin: proposal.capability.admin } : {}),
    limits: proposal.capability.limits,
    unknownObservedCount: unknownCapabilityCount(proposal.capability),
    conversationField,
    mission,
    innerState,
  };
}

/** Return true when the caller's explicit shadow flag and chat graylist allow recording. */
export function isSocialActShadowChat(
  chatId: number,
  config: { enabled: boolean; chatIds: number[] },
): boolean {
  if (!config.enabled || !validChatId(chatId)) return false;
  return config.chatIds.length === 0 || config.chatIds.includes(chatId);
}

/** Parse a model or host proposal. Validation never grants execution authority. */
export function parseSocialActProposal(value: unknown): SocialActProposal | null {
  const result = socialActProposalSchema.safeParse(value);
  if (!result.success) return null;
  const proposal = result.data;
  if (!isChatOnlyScope(proposal.scope)) return null;
  if (scopeKey(proposal.scope) !== scopeKey(proposal.capability.scope)) return null;
  if (!isChatOnlyScope(proposal.capability.scope)) return null;
  if (proposal.conversationField && !isChatOnlyScope(proposal.conversationField.scope)) return null;
  if (proposal.conversationField && scopeKey(proposal.conversationField.scope) !== scopeKey(proposal.scope)) {
    return null;
  }
  return proposal;
}

/**
 * Adapt the current judge result into the future action contract.
 * This deliberately contains no generated reply text: the shadow event is an
 * action observation, not a second prompt or a hidden reasoning store.
 */
export function buildLegacySocialActShadow(input: {
  chatId: number;
  message: FormattedMessage;
  judgeResult: JudgeResult;
  cognitiveAnchorEventId?: string;
  obligationTargetUid?: number;
  conversationField?: ConversationField;
  innerState?: InnerState;
  capability?: CapabilitySnapshot;
  threadId?: number;
  observedAt?: number;
}): SocialActProposal | null {
  if (!validChatId(input.chatId) || !validMessageId(input.message.messageId)) return null;
  const triggerEventId = boundedText(input.cognitiveAnchorEventId, 240);
  const confidence = boundedConfidence(input.judgeResult.confidence);
  const correlationId = `social-act:${input.chatId}:${input.message.messageId}`.slice(0, 240);
  const scope = { visibility: 'chat' as const, chatId: input.chatId };
  const targetUserId = validUserId(input.obligationTargetUid)
    ? input.obligationTargetUid
    : input.chatId > 0 && validUserId(input.message.uid)
      ? input.message.uid
      : undefined;
  const replyToMessageId = input.chatId < 0 && validUserId(input.message.uid)
    ? input.message.messageId
    : undefined;
  const proposal: SocialActProposal = {
    schema: 'social_act.v1',
    scope,
    ...(triggerEventId ? { triggerEventId } : {}),
    correlationId,
    source: 'legacy_judge',
    intent: intentForJudge(input.judgeResult.action),
    ...(targetUserId ? { targetUserId } : {}),
    ...(replyToMessageId ? { replyToMessageId } : {}),
    thoughtUnits: [],
    bubbles: [],
    media: [],
    expectedEffect: input.judgeResult.action === 'REPLY'
      ? 'deliver a context-appropriate reply'
      : 'preserve the current conversational floor',
    ...(confidence === undefined ? {} : { uncertainty: Number((1 - confidence).toFixed(4)) }),
    judge: {
      action: input.judgeResult.action,
      level: input.judgeResult.level,
      ...(input.judgeResult.replyPath ? { replyPath: input.judgeResult.replyPath } : {}),
      ...(boundedText(input.judgeResult.rule, 96) ? { rule: boundedText(input.judgeResult.rule, 96) } : {}),
      ...(confidence === undefined ? {} : { confidence }),
      latencyMs: Number.isSafeInteger(input.judgeResult.latencyMs)
        ? Math.max(0, input.judgeResult.latencyMs)
        : 0,
    },
    capability: input.capability ?? buildHostCapabilitySnapshot({
      scope,
      ...(input.observedAt ? { observedAt: input.observedAt } : {}),
      ...(input.threadId ? { threadId: input.threadId } : {}),
      chatKind: input.chatId > 0 ? 'private' : 'group',
    }),
    ...(input.conversationField ? { conversationField: input.conversationField } : {}),
    ...(input.innerState ? { innerState: input.innerState } : {}),
  };
  return parseSocialActProposal(proposal);
}

function sourceForProposal(proposal: SocialActProposal): 'host' | 'model' {
  return proposal.source === 'model' ? 'model' : 'host';
}

function parseRecord(event: CognitiveEvent, chatId: number): SocialActRecord | null {
  if (event.type !== 'social_act_proposed' || event.chatId !== chatId) return null;
  const fact = event.fact;
  const messageId = fact['messageId'];
  const intent = parseIntent(fact['intent']);
  if (!validMessageId(Number(messageId)) || !intent) return null;
  const targetUserId = validUserId(typeof fact['targetUserId'] === 'number' ? fact['targetUserId'] : undefined)
    ? fact['targetUserId'] as number
    : null;
  const source = fact['source'] === 'model' ? 'model' : fact['source'] === 'legacy_judge' ? 'legacy_judge' : null;
  if (!source) return null;
  const judgeAction = fact['judgeAction'] === 'REPLY' || fact['judgeAction'] === 'IGNORE' || fact['judgeAction'] === 'REJECT'
    ? fact['judgeAction']
    : null;
  const judgeLevel = fact['judgeLevel'] === 'L0_RULE' || fact['judgeLevel'] === 'L1_MICRO' || fact['judgeLevel'] === 'L2_AI'
    ? fact['judgeLevel']
    : null;
  const innerState = fact['innerState'];
  const currentNeed = innerState && typeof innerState === 'object'
    ? (innerState as Record<string, unknown>)['currentNeed']
    : undefined;
  const innerStateCurrentNeed: InnerState['currentNeed'] | null = currentNeed === 'witness'
    || currentNeed === 'company'
    || currentNeed === 'feedback'
    || currentNeed === 'challenge'
    || currentNeed === 'space'
    || currentNeed === 'repair'
    ? currentNeed
    : null;
  return {
    eventId: event.id,
    chatId,
    messageId: Number(messageId),
    userId: validUserId(typeof fact['userId'] === 'number' ? fact['userId'] : undefined)
      ? fact['userId'] as number
      : null,
    intent,
    targetUserId,
    replyToMessageId: validMessageId(Number(fact['replyToMessageId']))
      ? Number(fact['replyToMessageId'])
      : null,
    source,
    triggerEventId: event.causationId,
    correlationId: event.correlationId,
    occurredAt: event.occurredAt,
    judgeAction,
    judgeLevel,
    bubbleCount: typeof fact['bubbleCount'] === 'number' && Number.isSafeInteger(fact['bubbleCount'])
      ? Math.max(0, Math.min(32, fact['bubbleCount'] as number))
      : 0,
    mediaKinds: parseStringArray(fact['mediaKinds'], 8),
    mediaPurposes: parseStringArray(fact['mediaPurposes'], 8),
    hasFollowUp: fact['hasFollowUp'] === true,
    expectedEffect: typeof fact['expectedEffect'] === 'string' ? fact['expectedEffect'].slice(0, 240) : null,
    capabilityUnknownCount: typeof fact['capabilityUnknownCount'] === 'number'
      ? Math.max(0, Math.min(7, Math.trunc(fact['capabilityUnknownCount'])))
      : 0,
    innerStateCurrentNeed,
  };
}

/** Persist one bounded SocialAct proposal. It never dispatches an adapter. */
export function recordSocialActProposal(
  proposal: SocialActProposal,
  input: { messageId: number; userId?: number; occurredAt?: number },
): { inserted: boolean; eventId: string } | null {
  const parsed = parseSocialActProposal(proposal);
  if (!parsed) return null;
  if (!validChatId(parsed.scope.chatId ?? 0) || !validMessageId(input.messageId)) return null;
  const executionPlan = compileSocialActProposal(parsed);
  const messageUserId = validUserId(input.userId) ? input.userId : null;
  const dedupeKey = `social-act:${parsed.scope.chatId}:${input.messageId}`.slice(0, 240);
  const fact: Record<string, unknown> = {
    schema: parsed.schema,
    messageId: input.messageId,
    userId: messageUserId,
    source: parsed.source,
    intent: parsed.intent,
    targetUserId: parsed.targetUserId ?? null,
    replyToMessageId: parsed.replyToMessageId ?? null,
    thoughtUnitCount: parsed.thoughtUnits.length,
    bubbleCount: parsed.bubbles.length,
    mediaKinds: parsed.media.slice(0, 4).map((media) => media.kind),
    mediaPurposes: parsed.media.slice(0, 4).map((media) => media.purpose),
    hasFollowUp: !!parsed.followUp,
    expectedEffect: boundedText(parsed.expectedEffect, 160) ?? null,
    uncertainty: parsed.uncertainty ?? null,
    judgeAction: parsed.judge?.action ?? null,
    judgeLevel: parsed.judge?.level ?? null,
    judgeRule: boundedText(parsed.judge?.rule, 96) ?? null,
    judgeConfidence: parsed.judge?.confidence ?? null,
    judgeLatencyMs: parsed.judge?.latencyMs ?? null,
    metaDispatch: parsed.metaDispatch ?? null,
    capabilityUnknownCount: unknownCapabilityCount(parsed.capability),
    execution: executionPlan
      ? {
          executable: executionPlan.executable,
          blockedReasons: executionPlan.blockedReasons.slice(0, 8),
          deferredMediaCount: executionPlan.deferredMedia.length,
          compiledBubbleCount: executionPlan.bubbles.length,
        }
      : { executable: false, blockedReasons: ['compile_failed'], deferredMediaCount: 0, compiledBubbleCount: 0 },
    innerState: parsed.innerState
      ? {
          schema: parsed.innerState.schema,
          currentNeed: parsed.innerState.currentNeed ?? null,
          attention: parsed.innerState.attention,
          energy: parsed.innerState.energy,
          curiosity: parsed.innerState.curiosity,
          connection: parsed.innerState.connection,
          confidence: parsed.innerState.confidence,
          uncertainty: parsed.innerState.uncertainty,
          unresolvedCount: parsed.innerState.unresolved.length,
          wants: parsed.innerState.wants.slice(0, 4),
        }
      : null,
    capability: boundedProposalSummary(parsed),
  };
  const appended = appendCognitiveEvent({
    type: 'social_act_proposed',
    source: sourceForProposal(parsed),
    scope: parsed.scope,
    ...(input.occurredAt === undefined ? {} : { occurredAt: input.occurredAt }),
    ...(parsed.triggerEventId ? { causationId: parsed.triggerEventId } : {}),
    correlationId: parsed.correlationId,
    dedupeKey,
    fact,
  });
  return appended ? { inserted: appended.inserted, eventId: appended.event.id } : null;
}

/** Convenience bridge used by the legacy pipeline while SocialAct is shadowed. */
export function recordLegacySocialActShadow(input: {
  chatId: number;
  message: FormattedMessage;
  judgeResult: JudgeResult;
  cognitiveAnchorEventId?: string;
  obligationTargetUid?: number;
  conversationField?: ConversationField;
  innerState?: InnerState;
  capability?: CapabilitySnapshot;
  threadId?: number;
  observedAt?: number;
}): { inserted: boolean; eventId: string } | null {
  const proposal = buildLegacySocialActShadow(input);
  if (!proposal) return null;
  return recordSocialActProposal(proposal, {
    messageId: input.message.messageId,
    ...(validUserId(input.message.uid) ? { userId: input.message.uid } : {}),
    occurredAt: input.message.timestamp,
  });
}

/**
 * Adapt a Meta dispatch into the same proposal ledger as Reply/Heart.
 * `messageId` is the quoted Telegram anchor; proactive task dispatches without
 * a quote are intentionally left to the mission ledger instead of inventing a
 * social message event.
 */
export function recordMetaSocialActShadow(input: {
  chatId: number;
  messageId: number;
  layer: 'L0' | 'L1' | 'L1_CALLBACK' | 'L2';
  decision: 'proposed' | 'blocked' | 'skipped';
  decisionReason?: string;
  targetUserId?: number;
  interrupt?: boolean;
  cognitiveAnchorEventId?: string;
  taskId?: string;
  threadId?: number;
  observedAt?: number;
}): { inserted: boolean; eventId: string } | null {
  if (!validChatId(input.chatId) || !validMessageId(input.messageId)) return null;
  const scope = { visibility: 'chat' as const, chatId: input.chatId };
  const targetUserId = validUserId(input.targetUserId) ? input.targetUserId : undefined;
  const triggerEventId = boundedText(input.cognitiveAnchorEventId, 240);
  const intent: SocialActIntent = input.decision === 'proposed'
    ? 'answer'
    : input.decision === 'blocked'
      ? 'observe'
      : 'pause';
  const expectedEffect = input.decision === 'proposed'
    ? 'dispatch a context-appropriate CodeAct response'
    : 'preserve the current conversational floor';
  const proposal: SocialActProposal = {
    schema: 'social_act.v1',
    scope,
    ...(triggerEventId ? { triggerEventId } : {}),
    correlationId: `social-act:${input.chatId}:${input.messageId}`.slice(0, 240),
    source: 'model',
    intent,
    ...(targetUserId ? { targetUserId } : {}),
    replyToMessageId: input.messageId,
    thoughtUnits: [],
    bubbles: [],
    media: [],
    expectedEffect,
    uncertainty: input.decision === 'proposed' ? 0.35 : 0.8,
    metaDispatch: {
      layer: input.layer,
      decision: input.decision,
      ...(boundedText(input.decisionReason, 120) ? { decisionReason: boundedText(input.decisionReason, 120) } : {}),
      interrupt: input.interrupt === true,
      ...(boundedText(input.taskId, 160) ? { taskId: boundedText(input.taskId, 160) } : {}),
    },
    capability: buildHostCapabilitySnapshot({
      scope,
      ...(input.observedAt ? { observedAt: input.observedAt } : {}),
      ...(input.threadId ? { threadId: input.threadId } : {}),
      chatKind: input.chatId > 0 ? 'private' : 'group',
    }),
  };
  const parsed = parseSocialActProposal(proposal);
  if (!parsed) return null;
  const recorded = recordSocialActProposal(parsed, {
    messageId: input.messageId,
    ...(targetUserId ? { userId: targetUserId } : {}),
    ...(input.observedAt ? { occurredAt: input.observedAt } : {}),
  });
  return recorded;
}

/** Read bounded proposals for one chat, newest first. */
export function listSocialActProposals(options: { chatId: number; limit?: number }): SocialActRecord[] {
  if (!validChatId(options.chatId)) return [];
  const limit = Math.min(2000, Math.max(1, Number.isSafeInteger(options.limit) ? options.limit! : 100));
  return listCognitiveEvents({
    scope: { visibility: 'chat', chatId: options.chatId },
    type: 'social_act_proposed',
    order: 'occurred_at_desc',
    limit,
  })
    .map((event) => parseRecord(event, options.chatId))
    .filter((record): record is SocialActRecord => !!record);
}

function findProposalForMessage(chatId: number, messageId: number): { eventId: string; record: SocialActRecord } | null {
  const correlationId = `social-act:${chatId}:${messageId}`;
  const events = listCognitiveEvents({
    scope: { visibility: 'chat', chatId },
    type: 'social_act_proposed',
    correlationId,
    order: 'occurred_at_desc',
    limit: 4,
  });
  for (const event of events) {
    const record = parseRecord(event, chatId);
    if (record && record.messageId === messageId) return { eventId: event.id, record };
  }
  return null;
}

function expectedDelivery(intent: SocialActIntent): boolean {
  return intent !== 'pause' && intent !== 'observe';
}

function predictionErrorFor(intent: SocialActIntent, status: SocialActOutcomeStatus): number | undefined {
  if (status === 'failed' || status === 'interrupted') return undefined;
  const delivered = status === 'delivered';
  return expectedDelivery(intent) === delivered ? 0 : 1;
}

/** Persist one host-observed outcome for an existing proposal. */
export function recordSocialActOutcome(
  outcome: SocialActOutcome,
  input: { messageId: number; occurredAt?: number },
): { inserted: boolean; eventId: string; outcome: SocialActOutcomeRecord } | null {
  const parsed = socialActOutcomeSchema.safeParse(outcome);
  if (!parsed.success || !validMessageId(input.messageId)) return null;
  const chatId = parsed.data.scope.chatId ?? 0;
  if (!validChatId(chatId)) return null;
  const proposal = findProposalForMessage(chatId, input.messageId);
  if (!proposal) return null;
  // A Telegram message id is only unique inside a chat. Keep the complete
  // cognitive scope attached to the proposal so a task/user-scoped outcome
  // cannot be smuggled onto a chat-scoped action (or vice versa).
  if (!isChatOnlyScope(parsed.data.scope)) return null;

  const predictionError = parsed.data.predictionError ?? predictionErrorFor(proposal.record.intent, parsed.data.status);
  const replyTargetResolved = proposal.record.replyToMessageId === null
    ? null
    : parsed.data.targetMessageIds.includes(proposal.record.replyToMessageId);
  const dedupeKey = `social-act-outcome:${chatId}:${input.messageId}`.slice(0, 240);
  const fact: Record<string, unknown> = {
    schema: parsed.data.schema,
    messageId: input.messageId,
    proposalEventId: proposal.eventId,
    proposalIntent: proposal.record.intent,
    status: parsed.data.status,
    reason: boundedText(parsed.data.reason, 160) ?? null,
    plannedBubbleCount: parsed.data.plannedBubbleCount,
    deliveredBubbleCount: parsed.data.deliveredBubbleCount,
    targetMessageIds: parsed.data.targetMessageIds,
    deliveredMessageIds: parsed.data.deliveredMessageIds,
    typingBeforeMs: parsed.data.typingBeforeMs ?? null,
    media: parsed.data.media,
    observedEffects: parsed.data.observedEffects ?? null,
    predictionError: predictionError ?? null,
    replyTargetResolved,
  };
  const appended = appendCognitiveEvent({
    type: 'social_act_outcome',
    source: 'host',
    scope: parsed.data.scope,
    ...(input.occurredAt === undefined ? {} : { occurredAt: input.occurredAt }),
    causationId: proposal.eventId,
    correlationId: proposal.record.correlationId,
    dedupeKey,
    fact,
  });
  if (!appended) return null;
  return {
    inserted: appended.inserted,
    eventId: appended.event.id,
    outcome: {
      eventId: appended.event.id,
      chatId,
      messageId: input.messageId,
      proposalEventId: proposal.eventId,
      status: parsed.data.status,
      reason: parsed.data.reason ?? null,
      occurredAt: appended.event.occurredAt,
      plannedBubbleCount: parsed.data.plannedBubbleCount,
      deliveredBubbleCount: parsed.data.deliveredBubbleCount,
      targetMessageIds: parsed.data.targetMessageIds,
      deliveredMessageIds: parsed.data.deliveredMessageIds,
      typingBeforeMs: parsed.data.typingBeforeMs ?? null,
      media: parsed.data.media,
      predictionError: predictionError ?? null,
      replyTargetResolved,
    },
  };
}

/** Convenience adapter for the legacy delivery path. */
export function recordLegacySocialActOutcome(input: {
  chatId: number;
  messageId: number;
  status: 'sent' | 'silent' | 'blocked' | 'failed' | 'interrupted';
  reason?: string;
  completedAt?: number;
  plannedBubbleCount?: number;
  deliveredBubbleCount?: number;
  targetMessageIds?: number[];
  deliveredMessageIds?: number[];
  typingBeforeMs?: number;
  media?: Partial<SocialActOutcome['media']>;
  observedEffects?: SocialActOutcome['observedEffects'];
}): { inserted: boolean; eventId: string } | null {
  if (!validChatId(input.chatId) || !validMessageId(input.messageId)) return null;
  const status: SocialActOutcomeStatus = input.status === 'sent' ? 'delivered' : input.status;
  const media = {
    stickers: Math.max(0, Math.trunc(input.media?.stickers ?? 0)),
    voices: Math.max(0, Math.trunc(input.media?.voices ?? 0)),
    polls: Math.max(0, Math.trunc(input.media?.polls ?? 0)),
    reactions: Math.max(0, Math.trunc(input.media?.reactions ?? 0)),
  };
  const outcome: SocialActOutcome = {
    schema: 'social_act_outcome.v1',
    scope: { visibility: 'chat', chatId: input.chatId },
    status,
    ...(boundedText(input.reason, 160) ? { reason: boundedText(input.reason, 160) } : {}),
    completedAt: input.completedAt ?? Math.floor(Date.now() / 1000),
    plannedBubbleCount: Math.max(0, Math.min(32, Math.trunc(input.plannedBubbleCount ?? 0))),
    deliveredBubbleCount: Math.max(0, Math.min(32, Math.trunc(input.deliveredBubbleCount ?? 0))),
    targetMessageIds: parseNumberArray(input.targetMessageIds ?? [], 32),
    deliveredMessageIds: parseNumberArray(input.deliveredMessageIds ?? [], 32),
    ...(input.typingBeforeMs !== undefined ? { typingBeforeMs: Math.max(0, Math.trunc(input.typingBeforeMs)) } : {}),
    media,
    ...(input.observedEffects ? { observedEffects: input.observedEffects } : {}),
  };
  const recorded = recordSocialActOutcome(outcome, { messageId: input.messageId });
  return recorded ? { inserted: recorded.inserted, eventId: recorded.eventId } : null;
}

function parseOutcome(event: CognitiveEvent, chatId: number): SocialActOutcomeRecord | null {
  if (event.type !== 'social_act_outcome' || event.chatId !== chatId) return null;
  const fact = event.fact;
  const status = parseOutcomeStatus(fact['status']);
  const messageId = Number(fact['messageId']);
  if (!status || !validMessageId(messageId)) return null;
  const media = fact['media'];
  const mediaRecord = media && typeof media === 'object' ? media as Record<string, unknown> : {};
  const predictionError = typeof fact['predictionError'] === 'number'
    ? Math.min(1, Math.max(0, fact['predictionError']))
    : null;
  return {
    eventId: event.id,
    chatId,
    messageId,
    proposalEventId: typeof fact['proposalEventId'] === 'string' ? fact['proposalEventId'] : null,
    status,
    reason: typeof fact['reason'] === 'string' ? fact['reason'].slice(0, 160) : null,
    occurredAt: event.occurredAt,
    plannedBubbleCount: typeof fact['plannedBubbleCount'] === 'number' ? Math.max(0, Math.trunc(fact['plannedBubbleCount'])) : 0,
    deliveredBubbleCount: typeof fact['deliveredBubbleCount'] === 'number' ? Math.max(0, Math.trunc(fact['deliveredBubbleCount'])) : 0,
    targetMessageIds: parseNumberArray(fact['targetMessageIds'], 32),
    deliveredMessageIds: parseNumberArray(fact['deliveredMessageIds'], 32),
    typingBeforeMs: typeof fact['typingBeforeMs'] === 'number' ? Math.max(0, Math.trunc(fact['typingBeforeMs'])) : null,
    media: {
      stickers: typeof mediaRecord['stickers'] === 'number' ? Math.max(0, Math.trunc(mediaRecord['stickers'])) : 0,
      voices: typeof mediaRecord['voices'] === 'number' ? Math.max(0, Math.trunc(mediaRecord['voices'])) : 0,
      polls: typeof mediaRecord['polls'] === 'number' ? Math.max(0, Math.trunc(mediaRecord['polls'])) : 0,
      reactions: typeof mediaRecord['reactions'] === 'number' ? Math.max(0, Math.trunc(mediaRecord['reactions'])) : 0,
    },
    predictionError,
    replyTargetResolved: typeof fact['replyTargetResolved'] === 'boolean' ? fact['replyTargetResolved'] : null,
  };
}

/** Read bounded outcomes for one chat, newest first. */
export function listSocialActOutcomes(options: { chatId: number; limit?: number }): SocialActOutcomeRecord[] {
  if (!validChatId(options.chatId)) return [];
  const limit = Math.min(2000, Math.max(1, Number.isSafeInteger(options.limit) ? options.limit! : 100));
  return listCognitiveEvents({
    scope: { visibility: 'chat', chatId: options.chatId },
    type: 'social_act_outcome',
    order: 'occurred_at_desc',
    limit,
  })
    .map((event) => parseOutcome(event, options.chatId))
    .filter((record): record is SocialActOutcomeRecord => !!record);
}

/** Replay proposal/outcome pairs into bounded Phase 1 evaluation metrics. */
export function replaySocialActs(options: {
  chatId: number;
  proposalLimit?: number;
  outcomeLimit?: number;
  nowSec?: number;
}): SocialActReplayReport {
  const proposals = listSocialActProposals({ chatId: options.chatId, limit: options.proposalLimit ?? 500 });
  const outcomes = listSocialActOutcomes({ chatId: options.chatId, limit: options.outcomeLimit ?? 500 });
  const outcomesByMessage = new Map<number, SocialActOutcomeRecord>();
  for (const outcome of outcomes) {
    if (!outcomesByMessage.has(outcome.messageId)) outcomesByMessage.set(outcome.messageId, outcome);
  }
  const proposalEventIds = new Set(proposals.map((proposal) => proposal.eventId));
  const statusCounts: Record<SocialActOutcomeStatus, number> = {
    delivered: 0,
    silent: 0,
    blocked: 0,
    failed: 0,
    interrupted: 0,
  };
  const intentCounts: Partial<Record<SocialActIntent, number>> = {};
  const intentStatusCounts: Record<string, Partial<Record<SocialActOutcomeStatus, number>>> = {};
  const mediaPurposeCounts: Record<string, number> = {};
  const actualMediaCounts = { stickers: 0, voices: 0, polls: 0, reactions: 0 };
  let missingOutcomes = 0;
  let orphanOutcomes = 0;
  let plannedBubbles = 0;
  let deliveredBubbles = 0;
  let multiBubbleProposals = 0;
  let multiBubbleDeliveries = 0;
  let replyTargetsExpected = 0;
  let replyTargetsResolved = 0;
  let predictionEligible = 0;
  let predictionErrorSum = 0;
  let predictionExact = 0;

  for (const proposal of proposals) {
    intentCounts[proposal.intent] = (intentCounts[proposal.intent] ?? 0) + 1;
    const outcome = outcomesByMessage.get(proposal.messageId) ?? null;
    // Legacy proposals are recorded before the writer runs, so their bubble
    // count is intentionally zero. The host outcome contains the observed
    // plan count and is the authoritative replay value for that path.
    const plannedBubbleCount = proposal.bubbleCount > 0
      ? proposal.bubbleCount
      : outcome?.plannedBubbleCount ?? 0;
    plannedBubbles += plannedBubbleCount;
    if (plannedBubbleCount > 1) multiBubbleProposals += 1;
    for (const purpose of proposal.mediaPurposes) {
      mediaPurposeCounts[purpose] = (mediaPurposeCounts[purpose] ?? 0) + 1;
    }
    if (!outcome) {
      missingOutcomes += 1;
      continue;
    }
    statusCounts[outcome.status] += 1;
    const byIntent = intentStatusCounts[proposal.intent] ?? {};
    byIntent[outcome.status] = (byIntent[outcome.status] ?? 0) + 1;
    intentStatusCounts[proposal.intent] = byIntent;
    deliveredBubbles += outcome.deliveredBubbleCount;
    if (outcome.deliveredBubbleCount > 1) multiBubbleDeliveries += 1;
    actualMediaCounts.stickers += outcome.media.stickers;
    actualMediaCounts.voices += outcome.media.voices;
    actualMediaCounts.polls += outcome.media.polls;
    actualMediaCounts.reactions += outcome.media.reactions;
    if (outcome.replyTargetResolved !== null) {
      replyTargetsExpected += 1;
      if (outcome.replyTargetResolved) replyTargetsResolved += 1;
    }
    if (outcome.predictionError !== null) {
      predictionEligible += 1;
      predictionErrorSum += outcome.predictionError;
      if (outcome.predictionError === 0) predictionExact += 1;
    }
  }

  for (const outcome of outcomes) {
    if (!outcome.proposalEventId || !proposalEventIds.has(outcome.proposalEventId)) orphanOutcomes += 1;
  }

  const recent = proposals.slice(0, 50).map((proposal) => {
    const outcome = outcomesByMessage.get(proposal.messageId) ?? null;
    return {
      messageId: proposal.messageId,
      intent: proposal.intent,
      status: outcome?.status ?? null,
      plannedBubbles: proposal.bubbleCount,
      deliveredBubbles: outcome?.deliveredBubbleCount ?? 0,
      expectedEffect: proposal.expectedEffect,
    };
  });

  return {
    schema: 'social_act_replay.v1',
    chatId: options.chatId,
    asOf: Number.isSafeInteger(options.nowSec) && (options.nowSec ?? 0) > 0
      ? options.nowSec!
      : Math.floor(Date.now() / 1000),
    totalProposals: proposals.length,
    totalOutcomes: outcomes.length,
    missingOutcomes,
    orphanOutcomes,
    statusCounts,
    intentCounts,
    intentStatusCounts,
    delivery: {
      plannedBubbles,
      deliveredBubbles,
      multiBubbleProposals,
      multiBubbleDeliveries,
    },
    replyTargets: {
      expected: replyTargetsExpected,
      resolved: replyTargetsResolved,
      resolutionRate: replyTargetsExpected > 0 ? Number((replyTargetsResolved / replyTargetsExpected).toFixed(4)) : null,
    },
    mediaPurposeCounts,
    actualMediaCounts,
    prediction: {
      eligible: predictionEligible,
      meanError: predictionEligible > 0 ? Number((predictionErrorSum / predictionEligible).toFixed(4)) : null,
      exactRate: predictionEligible > 0 ? Number((predictionExact / predictionEligible).toFixed(4)) : null,
    },
    recent,
  };
}
