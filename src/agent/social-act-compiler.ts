// Compile a bounded SocialAct proposal into a host-executable plan.
//
// Compilation is deliberately pure. It validates scope and Telegram limits,
// separates unavailable media from text delivery, and never calls an adapter.
// The sender remains the only component that can create a Telegram side effect.

import { socialActProposalSchema, type SocialActProposal } from './social-act.js';
import type { CapabilitySnapshot } from './nyatos-contracts.js';
import { scopeKey, type CognitiveScope } from '../shared/cognitive-scope.js';

export interface CompiledSocialActBubble {
  text: string;
  pauseAfterMs?: number;
  replyToMessageId?: number;
}

export interface DeferredSocialActMedia {
  kind: string;
  purpose: string;
  reason: 'capability_unknown' | 'capability_unavailable' | 'limit_exceeded';
}

export interface SocialActExecutionPlan {
  scope: CognitiveScope;
  intent: SocialActProposal['intent'];
  bubbles: CompiledSocialActBubble[];
  deferredMedia: DeferredSocialActMedia[];
  reaction?: string;
  followUp?: SocialActProposal['followUp'];
  blockedReasons: string[];
  executable: boolean;
}

function boundedPause(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isSafeInteger(value)) return undefined;
  return Math.min(10 * 60_000, Math.max(0, value));
}

function sameChatScope(left: CognitiveScope, right: CognitiveScope): boolean {
  try {
    return scopeKey(left) === scopeKey(right)
      && left.visibility === 'chat'
      && right.visibility === 'chat';
  } catch {
    return false;
  }
}

function mediaCapability(capability: CapabilitySnapshot, kind: string): boolean | null {
  switch (kind) {
    case 'photo':
    case 'document':
    case 'link':
      return capability.observed.canSendMedia;
    case 'sticker':
      return capability.observed.canSendSticker;
    case 'voice':
      return capability.observed.canSendVoice;
    case 'poll':
      return capability.observed.canPoll;
    default:
      return null;
  }
}

/**
 * Convert a model/legacy proposal into bounded host work. Unknown capabilities
 * defer optional media instead of treating an adapter as permission evidence.
 */
export function compileSocialActProposal(
  proposal: SocialActProposal,
  input: { capability?: CapabilitySnapshot } = {},
): SocialActExecutionPlan | null {
  const parsed = socialActProposalSchema.safeParse(proposal);
  if (!parsed.success || parsed.data.scope.visibility !== 'chat') return null;
  const value = parsed.data;
  const capability = input.capability ?? value.capability;
  if (!sameChatScope(value.scope, capability.scope)) return null;

  const blockedReasons: string[] = [];
  const bubbles = value.bubbles
    .slice(0, capability.limits.maxBubbles)
    .map((bubble) => ({
      text: bubble.text.trim().slice(0, capability.limits.maxTextChars),
      ...(boundedPause(bubble.pauseAfterMs) === undefined ? {} : { pauseAfterMs: boundedPause(bubble.pauseAfterMs) }),
      ...(bubble.replyToMessageId === undefined ? {} : { replyToMessageId: bubble.replyToMessageId }),
    }))
    .filter((bubble) => bubble.text.length > 0);

  if (value.bubbles.length > capability.limits.maxBubbles) blockedReasons.push('bubble_limit_exceeded');
  if (capability.observed.canSendText === false && bubbles.length > 0) blockedReasons.push('text_capability_unavailable');
  if (bubbles.length === 0 && value.intent !== 'pause' && value.intent !== 'observe') blockedReasons.push('no_text_action');

  const deferredMedia: DeferredSocialActMedia[] = [];
  for (const [index, media] of value.media.entries()) {
    if (index >= capability.limits.maxMediaItems) {
      deferredMedia.push({ kind: media.kind, purpose: media.purpose, reason: 'limit_exceeded' });
      continue;
    }
    const available = mediaCapability(capability, media.kind);
    if (available === false) {
      deferredMedia.push({ kind: media.kind, purpose: media.purpose, reason: 'capability_unavailable' });
    } else if (available === null) {
      deferredMedia.push({ kind: media.kind, purpose: media.purpose, reason: 'capability_unknown' });
    }
  }

  return {
    scope: value.scope,
    intent: value.intent,
    bubbles,
    deferredMedia,
    ...(value.reaction ? { reaction: value.reaction } : {}),
    ...(value.followUp ? { followUp: value.followUp } : {}),
    blockedReasons,
    executable: blockedReasons.length === 0 && (bubbles.length > 0 || value.intent === 'pause' || value.intent === 'observe'),
  };
}
