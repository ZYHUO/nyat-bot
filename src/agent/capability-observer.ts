// Host-owned Telegram capability observation.
//
// This is deliberately a read-only probe. It reports what Telegram says about
// the bot's membership and rights; it never turns those facts into an action
// and never lets a model proposal widen the scope of a later adapter call.

import { getBotPermissions, type BotPermissionSnapshot } from '../admin/bot-permission.js';
import { tryGetBot } from '../bot/bot.js';
import {
  buildHostCapabilitySnapshot,
  type CapabilitySnapshot,
} from './nyatos-contracts.js';
import type { CognitiveScope } from '../shared/cognitive-scope.js';

const CACHE_TTL_MS = 5 * 60_000;

interface CacheEntry {
  snapshot: CapabilitySnapshot;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<CapabilitySnapshot | null>>();

function cacheKey(scope: CognitiveScope, threadId?: number): string {
  return `${scope.chatId ?? 'global'}:${threadId ?? 'general'}`;
}

function statusOf(value: string): NonNullable<CapabilitySnapshot['admin']>['status'] {
  if (
    value === 'creator'
    || value === 'administrator'
    || value === 'member'
    || value === 'restricted'
    || value === 'left'
    || value === 'kicked'
  ) return value;
  return 'unknown';
}

function snapshotFromPermissions(
  scope: CognitiveScope,
  permissions: BotPermissionSnapshot,
  observedAt: number,
  threadId?: number,
): CapabilitySnapshot {
  return buildHostCapabilitySnapshot({
    scope,
    observedAt,
    ...(threadId === undefined ? {} : { threadId }),
    chatKind: scope.chatId !== undefined
      ? scope.chatId > 0 ? 'private' : 'group'
      : 'unknown',
    observedEffects: {
      canSendText: permissions.can_send_messages,
      canSendMedia: permissions.can_send_media,
      canPoll: permissions.can_send_polls,
      canSendSticker: permissions.can_send_other_messages,
      canSendVoice: permissions.can_send_voice,
      // Telegram has no separate bot-member flag for reacting. Leave it
      // unknown instead of inferring it from administrator status.
      canReact: null,
      canDeleteOwn: null,
    },
    admin: {
      status: statusOf(permissions.status),
      canDeleteMessages: permissions.can_delete_messages,
      canPinMessages: permissions.can_pin_messages,
      canManageChat: permissions.can_manage_chat,
      canManageTopics: permissions.can_manage_topics,
      canRestrictMembers: permissions.can_restrict_members,
      canInviteUsers: permissions.can_invite_users,
      isAnonymous: permissions.is_anonymous,
    },
  });
}

async function probe(
  scope: CognitiveScope,
  threadId: number | undefined,
): Promise<CapabilitySnapshot | null> {
  const chatId = scope.chatId;
  if (chatId === undefined || chatId === 0) return null;
  const bot = tryGetBot();
  if (!bot) return null;
  const permissions = await getBotPermissions(bot, chatId);
  if (!permissions) return null;
  return snapshotFromPermissions(scope, permissions, Math.floor(Date.now() / 1000), threadId);
}

/**
 * Read Telegram membership/admin facts with a short per-chat cache. Concurrent
 * messages share one in-flight probe, so enabling the shadow canary does not
 * add one Bot API request pair per message.
 */
export async function observeTelegramCapabilitySnapshot(input: {
  scope: CognitiveScope;
  threadId?: number;
}): Promise<CapabilitySnapshot | null> {
  const key = cacheKey(input.scope, input.threadId);
  const current = cache.get(key);
  if (current && current.expiresAt > Date.now()) return current.snapshot;
  const running = inFlight.get(key);
  if (running) return running;
  const request = probe(input.scope, input.threadId)
    .then((snapshot) => {
      if (snapshot) cache.set(key, { snapshot, expiresAt: Date.now() + CACHE_TTL_MS });
      return snapshot;
    })
    .finally(() => {
      inFlight.delete(key);
    });
  inFlight.set(key, request);
  return request;
}

/** Test/process lifecycle hook; production normally lets the TTL expire. */
export function clearCapabilityObservationCache(): void {
  cache.clear();
  inFlight.clear();
}

