// Phase 0 NyatOS data contracts.
//
// These schemas only describe proposals and host observations. Parsing a value
// never grants execution authority, changes a belief, or turns model text into
// an observed fact. Hosts must still attach receipts before anything is treated
// as delivered or completed.

import { z } from 'zod';
import type { CognitiveScope } from '../shared/cognitive-scope.js';

const nonZeroChatId = z.number().int().refine((value) => value !== 0, 'chatId must be non-zero');

export const cognitiveScopeSchema = z.object({
  visibility: z.enum(['global', 'chat', 'user', 'task']),
  chatId: nonZeroChatId.optional(),
  userId: z.number().int().positive().optional(),
  taskId: z.string().trim().min(1).max(160).optional(),
}).strict();

export const realityClassSchema = z.enum(['observed', 'inferred', 'imagined', 'committed']);
export type RealityClass = z.infer<typeof realityClassSchema>;

export const realityLedgerEntrySchema = z.object({
  schema: z.literal('reality_entry.v1'),
  realityClass: realityClassSchema,
  source: z.enum(['telegram', 'host', 'tool', 'scheduler', 'model', 'dream', 'replay']),
  scope: cognitiveScopeSchema,
  occurredAt: z.number().int().positive(),
  recordedAt: z.number().int().positive(),
  confidence: z.number().min(0).max(1),
  evidenceEventIds: z.array(z.string().trim().min(1).max(240)).max(32),
  counterEvidenceEventIds: z.array(z.string().trim().min(1).max(240)).max(32).optional(),
  expiresAt: z.number().int().positive().optional(),
  payload: z.record(z.unknown()).optional(),
}).strict();
export type RealityLedgerEntry = z.infer<typeof realityLedgerEntrySchema>;

export const innerStateSchema = z.object({
  schema: z.literal('inner_state.v1'),
  attention: z.number().min(0).max(1),
  energy: z.number().min(0).max(1),
  curiosity: z.number().min(0).max(1),
  connection: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  uncertainty: z.number().min(0).max(1),
  unresolved: z.array(z.string().trim().min(1).max(160)).max(16),
  wants: z.array(z.string().trim().min(1).max(160)).max(16),
  aversions: z.array(z.string().trim().min(1).max(160)).max(16),
  commitments: z.array(z.string().trim().min(1).max(160)).max(16),
  currentNeed: z.enum(['witness', 'company', 'feedback', 'challenge', 'space', 'repair']).optional(),
  updatedAt: z.number().int().positive(),
}).strict();
export type InnerState = z.infer<typeof innerStateSchema>;

export const affectEpisodeSchema = z.object({
  schema: z.literal('affect_episode.v1'),
  id: z.string().trim().min(1).max(160),
  scope: cognitiveScopeSchema,
  kind: z.enum(['joy', 'hurt', 'relief', 'frustration', 'curiosity', 'loneliness', 'pride', 'shame', 'calm', 'mixed']),
  intensity: z.number().min(0).max(1),
  valence: z.number().min(-1).max(1),
  arousal: z.number().min(0).max(1),
  startedAt: z.number().int().positive(),
  updatedAt: z.number().int().positive(),
  status: z.enum(['active', 'resolved', 'superseded']),
  triggerEventIds: z.array(z.string().trim().min(1).max(240)).max(32),
  expressionState: z.string().trim().min(1).max(240).optional(),
  resolution: z.string().trim().min(1).max(240).optional(),
}).strict();
export type AffectEpisode = z.infer<typeof affectEpisodeSchema>;

export const missionProposalSchema = z.object({
  schema: z.literal('mission_proposal.v1'),
  objective: z.string().trim().min(1).max(320),
  scope: cognitiveScopeSchema,
  successChecks: z.array(z.string().trim().min(1).max(200)).min(1).max(8),
  watchFor: z.array(z.string().trim().min(1).max(200)).max(8),
  nextWakeAt: z.number().int().positive().optional(),
  deadlineAt: z.number().int().positive().optional(),
  budget: z.object({
    maxAttempts: z.number().int().min(1).max(100),
    maxWallClockSec: z.number().int().min(1).max(7 * 86400),
  }).strict(),
  status: z.literal('proposed'),
}).strict();
export type MissionProposal = z.infer<typeof missionProposalSchema>;

export const sensorKindSchema = z.enum([
  'conversation',
  'telegram',
  'memory',
  'web',
  'relationship',
  'system',
]);
export type SensorKind = z.infer<typeof sensorKindSchema>;

export const sensorMethodSchema = z.enum([
  'conversation.field',
  'telegram.recent_messages',
  'telegram.capability',
  'memory.search',
  'web.fetch',
  'relationship.snapshot',
  'system.provider_health',
  'replay.social_act',
]);
export type SensorMethod = z.infer<typeof sensorMethodSchema>;

/** A model-authored question for a host-owned, read-only observation. */
export const sensorProposalSchema = z.object({
  schema: z.literal('sensor_proposal.v1'),
  scope: cognitiveScopeSchema,
  kind: sensorKindSchema,
  method: sensorMethodSchema,
  question: z.string().trim().min(1).max(320),
  target: z.string().trim().min(1).max(240).optional(),
  prediction: z.string().trim().min(1).max(320),
  stopCondition: z.string().trim().min(1).max(240),
  sourceEventIds: z.array(z.string().trim().min(1).max(240)).max(32),
  expiresAt: z.number().int().positive().optional(),
  budget: z.object({
    maxAttempts: z.number().int().min(1).max(32),
    maxWallClockSec: z.number().int().min(1).max(7 * 86400),
  }).strict(),
  status: z.literal('candidate'),
}).strict();
export type SensorProposal = z.infer<typeof sensorProposalSchema>;

/** A model-authored preference/interest hypothesis, never an active policy by itself. */
export const valueProposalSchema = z.object({
  schema: z.literal('value_proposal.v1'),
  scope: cognitiveScopeSchema,
  name: z.string().trim().min(1).max(120),
  statement: z.string().trim().min(1).max(320),
  reason: z.string().trim().min(1).max(320),
  experiment: z.string().trim().min(1).max(320),
  successChecks: z.array(z.string().trim().min(1).max(200)).min(1).max(8),
  stopConditions: z.array(z.string().trim().min(1).max(200)).max(8),
  applicability: z.array(z.string().trim().min(1).max(160)).max(8),
  sourceEventIds: z.array(z.string().trim().min(1).max(240)).max(32),
  expiresAt: z.number().int().positive().optional(),
  status: z.literal('candidate'),
}).strict();
export type ValueProposal = z.infer<typeof valueProposalSchema>;

export const capabilitySnapshotSchema = z.object({
  schema: z.literal('capability_snapshot.v1'),
  scope: cognitiveScopeSchema,
  observedAt: z.number().int().positive(),
  chatKind: z.enum(['private', 'group', 'channel', 'unknown']),
  threadId: z.number().int().positive().optional(),
  transport: z.object({
    sendText: z.enum(['host_adapter', 'model_tool', 'unavailable']),
    sendMedia: z.enum(['host_adapter', 'model_tool', 'unavailable']),
    react: z.enum(['host_adapter', 'model_tool', 'unavailable']),
    poll: z.enum(['host_adapter', 'model_tool', 'unavailable']),
    sticker: z.enum(['host_adapter', 'model_tool', 'unavailable']),
    voice: z.enum(['host_adapter', 'model_tool', 'unavailable']),
    deleteOwn: z.enum(['host_adapter', 'model_tool', 'unavailable']),
  }).strict(),
  // null means "not observed yet". It must not be upgraded to true from a
  // model proposal or an adapter merely being compiled into the process.
  observed: z.object({
    canSendText: z.boolean().nullable(),
    canSendMedia: z.boolean().nullable(),
    canReact: z.boolean().nullable(),
    canPoll: z.boolean().nullable(),
    canSendSticker: z.boolean().nullable(),
    canSendVoice: z.boolean().nullable(),
    canDeleteOwn: z.boolean().nullable(),
  }).strict(),
  // Telegram membership/admin facts observed by the host. These are context
  // for proposal selection only; the adapter still owns every side effect.
  admin: z.object({
    status: z.enum(['creator', 'administrator', 'member', 'restricted', 'left', 'kicked', 'unknown']),
    canDeleteMessages: z.boolean().nullable(),
    canPinMessages: z.boolean().nullable(),
    canManageChat: z.boolean().nullable(),
    canManageTopics: z.boolean().nullable(),
    canRestrictMembers: z.boolean().nullable(),
    canInviteUsers: z.boolean().nullable(),
    isAnonymous: z.boolean().nullable(),
  }).strict().optional(),
  limits: z.object({
    maxTextChars: z.number().int().min(1).max(4096),
    maxBubbles: z.number().int().min(1).max(32),
    maxMediaItems: z.number().int().min(0).max(10),
    maxReactions: z.number().int().min(0).max(8),
    maxPolls: z.number().int().min(0).max(2),
  }).strict(),
}).strict();
export type CapabilitySnapshot = z.infer<typeof capabilitySnapshotSchema>;

export function parseRealityLedgerEntry(value: unknown): RealityLedgerEntry | null {
  const result = realityLedgerEntrySchema.safeParse(value);
  return result.success ? result.data : null;
}

export function parseInnerState(value: unknown): InnerState | null {
  const result = innerStateSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function parseAffectEpisode(value: unknown): AffectEpisode | null {
  const result = affectEpisodeSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function parseMissionProposal(value: unknown): MissionProposal | null {
  const result = missionProposalSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function parseSensorProposal(value: unknown): SensorProposal | null {
  const result = sensorProposalSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function parseValueProposal(value: unknown): ValueProposal | null {
  const result = valueProposalSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function parseCapabilitySnapshot(value: unknown): CapabilitySnapshot | null {
  const result = capabilitySnapshotSchema.safeParse(value);
  return result.success ? result.data : null;
}

/** Build the conservative capability view used by shadow proposals. */
export function buildHostCapabilitySnapshot(input: {
  scope: CognitiveScope;
  observedAt?: number;
  threadId?: number;
  chatKind?: 'private' | 'group' | 'channel' | 'unknown';
  observedEffects?: Partial<CapabilitySnapshot['observed']>;
  admin?: CapabilitySnapshot['admin'];
}): CapabilitySnapshot {
  const observedAt = Number.isSafeInteger(input.observedAt) && (input.observedAt ?? 0) > 0
    ? input.observedAt!
    : Math.floor(Date.now() / 1000);
  const chatKind = input.chatKind
    ?? (input.scope.chatId !== undefined ? (input.scope.chatId > 0 ? 'private' : 'group') : 'unknown');
  return {
    schema: 'capability_snapshot.v1',
    scope: input.scope,
    observedAt,
    chatKind,
    ...(input.threadId && Number.isSafeInteger(input.threadId) && input.threadId > 0 ? { threadId: input.threadId } : {}),
    transport: {
      sendText: 'host_adapter',
      sendMedia: 'host_adapter',
      react: 'host_adapter',
      poll: 'host_adapter',
      sticker: 'host_adapter',
      voice: 'host_adapter',
      deleteOwn: 'host_adapter',
    },
    observed: {
      canSendText: input.observedEffects?.canSendText ?? null,
      canSendMedia: input.observedEffects?.canSendMedia ?? null,
      canReact: input.observedEffects?.canReact ?? null,
      canPoll: input.observedEffects?.canPoll ?? null,
      canSendSticker: input.observedEffects?.canSendSticker ?? null,
      canSendVoice: input.observedEffects?.canSendVoice ?? null,
      canDeleteOwn: input.observedEffects?.canDeleteOwn ?? null,
    },
    ...(input.admin ? { admin: input.admin } : {}),
    limits: {
      maxTextChars: 4096,
      maxBubbles: 8,
      maxMediaItems: 4,
      maxReactions: 3,
      maxPolls: 1,
    },
  };
}
