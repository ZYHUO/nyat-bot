// Host-observable world facts.
//
// WHY THIS EXISTS
//
// The World projection had a consumer and no producer: `cognitive-projector`
// handled `world_change` events, but nothing in the repo ever emitted one, so
// `world_entities` stayed empty (and, before that, was polluted by reply
// instructions passed as entity names — see the 2026-09-18 audit).
//
// Meanwhile the model was missing facts the host already had: it did not know
// the group's title, type, or description. Those are not opinions or inferences
// — Telegram reports them, so they belong in the World as observed facts.
//
// DESIGN CONSTRAINTS (inherited from the projector)
//   1. `source` must be host/tool/scheduler. A model may not author a world fact;
//      model output is a hypothesis, and the projector rejects it.
//   2. `kind` must be person/project/topic/place, and the name must be short and
//      entity-shaped (enforced again inside upsertEntity).
//   3. Facts are per-chat scoped and idempotent: re-observing the same title must
//      not create a new revision, so the dedupe key includes the value.
//
// This module only observes and records. It never decides anything, and a
// failure here must never affect the message path.

import { tryGetBot } from '../bot/bot.js';
import { appendCognitiveEvent } from './cognitive-events.js';
import { logger } from '../shared/logger.js';
import { scopeKey, type CognitiveScope } from '../shared/cognitive-scope.js';

/** Telegram facts worth remembering about a chat, as reported by getChat. */
export interface ChatFacts {
  title?: string;
  type?: string;
  username?: string;
  description?: string;
  isForum?: boolean;
  linkedChatId?: number;
  hasProtectedContent?: boolean;
  slowModeDelay?: number;
}

interface CacheEntry {
  facts: ChatFacts;
  expiresAt: number;
}

/** getChat is rate-limited and its answer rarely changes; cache generously. */
const CACHE_TTL_MS = 30 * 60_000;
const cache = new Map<number, CacheEntry>();
const inFlight = new Map<number, Promise<ChatFacts | null>>();

function bounded(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/[\u0000-\u001f]/g, ' ').trim();
  return text ? text.slice(0, max) : undefined;
}

function toFacts(raw: Record<string, unknown>): ChatFacts {
  const facts: ChatFacts = {};
  const title = bounded(raw['title'], 120);
  if (title) facts.title = title;
  const type = bounded(raw['type'], 32);
  if (type) facts.type = type;
  // Store the bare handle. getChat normally returns it without '@', but a
  // relay/proxy may include one; strip it here so rendering never produces '@@'.
  const username = bounded(raw['username'], 64)?.replace(/^@+/, '');
  if (username) facts.username = username;
  const description = bounded(raw['description'], 240);
  if (description) facts.description = description;
  if (raw['is_forum'] === true) facts.isForum = true;
  const linked = raw['linked_chat_id'];
  if (typeof linked === 'number' && Number.isSafeInteger(linked) && linked !== 0) {
    facts.linkedChatId = linked;
  }
  if (raw['has_protected_content'] === true) facts.hasProtectedContent = true;
  const slow = raw['slow_mode_delay'];
  if (typeof slow === 'number' && Number.isFinite(slow) && slow > 0) {
    facts.slowModeDelay = Math.trunc(slow);
  }
  return facts;
}

async function probe(chatId: number): Promise<ChatFacts | null> {
  const bot = tryGetBot();
  if (!bot) return null;
  try {
    const raw = (await bot.api.getChat(chatId)) as unknown as Record<string, unknown>;
    return toFacts(raw);
  } catch (err) {
    logger.debug({ err, chatId }, 'world-facts: getChat failed');
    return null;
  }
}

/** Read chat facts with a cache; concurrent callers share one request. */
export async function observeChatFacts(chatId: number): Promise<ChatFacts | null> {
  if (!Number.isSafeInteger(chatId) || chatId === 0) return null;
  const cached = cache.get(chatId);
  if (cached && cached.expiresAt > Date.now()) return cached.facts;
  const running = inFlight.get(chatId);
  if (running) return running;
  const request = probe(chatId)
    .then((facts) => {
      if (facts) cache.set(chatId, { facts, expiresAt: Date.now() + CACHE_TTL_MS });
      return facts;
    })
    .finally(() => {
      inFlight.delete(chatId);
    });
  inFlight.set(chatId, request);
  return request;
}

/** Test/process lifecycle hook. */
export function clearChatFactsCache(): void {
  cache.clear();
  inFlight.clear();
}

/**
 * Emit `world_change` events for the facts Telegram reports about a chat.
 *
 * Idempotent per (chat, field, value): the dedupe key carries the value, so a
 * repeated observation is dropped while a genuine change writes a new revision.
 * The entity is the chat itself (kind `place`), because that is what the fact is
 * about — a stable, host-verifiable thing.
 */
export function recordChatFactsAsWorldChange(
  chatId: number,
  facts: ChatFacts,
): number {
  if (!Number.isSafeInteger(chatId) || chatId === 0) return 0;
  const scope: CognitiveScope = { visibility: 'chat', chatId };
  let key: string;
  try {
    key = scopeKey(scope);
  } catch {
    return 0;
  }
  const entityName = (facts.title ?? `chat:${chatId}`).slice(0, 40);
  const properties: Record<string, string> = {};
  if (facts.title) properties['title'] = facts.title;
  if (facts.type) properties['type'] = facts.type;
  if (facts.username) properties['username'] = `@${facts.username}`;
  if (facts.description) properties['description'] = facts.description;
  if (facts.isForum) properties['forum'] = 'true';
  if (facts.hasProtectedContent) properties['protected_content'] = 'true';
  if (facts.slowModeDelay) properties['slow_mode'] = `${facts.slowModeDelay}s`;
  if (facts.linkedChatId) properties['linked_chat'] = String(facts.linkedChatId);
  if (Object.keys(properties).length === 0) return 0;

  const fingerprint = JSON.stringify(properties);
  const result = appendCognitiveEvent({
    type: 'world_change',
    source: 'host',
    scope,
    correlationId: `world:chat:${key}`,
    dedupeKey: `world-change:chat:${key}:${fingerprint}`.slice(0, 240),
    fact: {
      schema: 'world_change.v1',
      entityName,
      entityKind: 'place',
      properties,
      confidence: 1,
    },
  });
  return result?.inserted ? 1 : 0;
}

/**
 * Observe a chat and, when enabled, record what Telegram reports as world facts.
 * Fire-and-forget by design: a world fact is background knowledge, never a
 * reason to delay or fail a message.
 */
export async function observeAndRecordChatFacts(
  chatId: number,
  enabled: boolean,
): Promise<number> {
  if (!enabled) return 0;
  const facts = await observeChatFacts(chatId);
  if (!facts) return 0;
  return recordChatFactsAsWorldChange(chatId, facts);
}
