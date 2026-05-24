// ────────────────────────────────────────
// 4-Way Context Retriever
// ────────────────────────────────────────
// Path 1: Recent Window
// Path 2: Semantic (stub — needs embeddings)
// Path 3: Thread (reply_to chain)
// Path 4: Entity (mentioned users)
// ────────────────────────────────────────

import type { FormattedMessage, RetrievedContext } from '../../shared/types.js';
import { getRecent, getAll } from './manager.js';
import { countTokens } from '../../ai/token-counter.js';
import { slimContextForAI, slimSingleMessage } from './slim.js';
import { searchMemory } from '../../memory/chroma.js';
import { logger } from '../../shared/logger.js';

export interface RetrieverConfig {
  mode: 'direct' | 'planned';
  recentWindow: number;
  semanticTopK: number;
  threadMaxDepth: number;
  entityMaxMessages: number;
  totalTokenBudget: number;
}

const DEFAULT_CONFIG: RetrieverConfig = {
  mode: 'planned',
  recentWindow: 50,
  semanticTopK: 10,
  threadMaxDepth: 8,
  entityMaxMessages: 5,
  totalTokenBudget: 48_000,
};

/**
 * Path 1: Recent window — last N messages from context.
 */
async function retrieveRecent(chatId: number, count: number): Promise<FormattedMessage[]> {
  const recent = await getRecent(chatId, count);
  return [...recent].sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Path 2: Semantic search — long-term memory via ChromaDB.
 * Hard 500ms timeout, returns [] on failure or timeout.
 */
async function retrieveSemantic(
  chatId: number,
  query: string,
  topK: number,
): Promise<FormattedMessage[]> {
  return searchMemory(chatId, query, topK, 500);
}

/**
 * Path 3: Thread trace — follow reply_to chain backwards.
 */
async function retrieveThread(
  _chatId: number,
  message: FormattedMessage,
  maxDepth: number,
  allMessages: FormattedMessage[],
): Promise<FormattedMessage[]> {
  if (!message.replyTo) return [];

  const byId = new Map<number, FormattedMessage>();
  for (const m of allMessages) {
    byId.set(m.messageId, m);
  }

  const thread: FormattedMessage[] = [];
  let current: FormattedMessage | undefined = message;

  for (let depth = 0; depth < maxDepth; depth++) {
    const replyToId = current?.replyTo?.messageId;
    if (!replyToId) break;

    const parent = byId.get(replyToId);
    if (!parent) break;

    thread.push(parent);
    current = parent;
  }

  return thread.reverse();
}

/**
 * Path 4: Entity — messages from users mentioned in the current message.
 * Extracts @username mentions from text.
 */
async function retrieveEntity(
  _chatId: number,
  message: FormattedMessage,
  maxMessages: number,
  allMessages: FormattedMessage[],
): Promise<FormattedMessage[]> {
  const text = message.textContent || message.captionContent || '';
  const mentions = text.match(/@(\w+)/g);
  if (!mentions || mentions.length === 0) return [];

  const mentionedUsernames = new Set(
    mentions.map((m) => m.slice(1).toLowerCase()),
  );

  const entityMessages: FormattedMessage[] = [];

  for (let i = allMessages.length - 1; i >= 0 && entityMessages.length < maxMessages; i--) {
    const m = allMessages[i]!;
    if (m.messageId === message.messageId) continue;
    if (m.username && mentionedUsernames.has(m.username.toLowerCase())) {
      entityMessages.push(m);
    }
  }

  return entityMessages.reverse();
}

/**
 * Deduplicate messages by messageId, preserving order of first appearance.
 */
function deduplicateMessages(messages: FormattedMessage[]): FormattedMessage[] {
  const seen = new Set<number>();
  const result: FormattedMessage[] = [];

  for (const msg of messages) {
    if (!seen.has(msg.messageId)) {
      seen.add(msg.messageId);
      result.push(msg);
    }
  }

  return result;
}

function appendExtrasWithinBudget(
  baseMessages: FormattedMessage[],
  extraMessages: FormattedMessage[],
  currentMessage: FormattedMessage,
  botUid: number,
  tokenBudget: number,
): FormattedMessage[] {
  const result = [...baseMessages];
  const seen = new Set(baseMessages.map((msg) => msg.messageId));
  let currentTokens = countTokens(slimContextForAI(result, currentMessage, botUid));

  const sortedExtras = [...extraMessages].sort((a, b) => a.timestamp - b.timestamp);
  for (const extra of sortedExtras) {
    if (seen.has(extra.messageId)) continue;
    // Estimate incremental token cost of this single message
    const extraTokens = countTokens(slimSingleMessage(extra, botUid));
    if (currentTokens + extraTokens > tokenBudget) continue;
    result.push(extra);
    seen.add(extra.messageId);
    currentTokens += extraTokens;
  }

  result.sort((a, b) => a.timestamp - b.timestamp);
  return result;
}

/**
 * Retrieve context using 4-way parallel strategy.
 */
export async function retrieveContext(
  chatId: number,
  message: FormattedMessage,
  botUid: number,
  config: Partial<RetrieverConfig> = {},
): Promise<RetrievedContext> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const queryText = message.textContent || message.captionContent || '';

  if (cfg.mode === 'direct') {
    const recent = await retrieveRecent(chatId, cfg.recentWindow);
    const recentContextStr = slimContextForAI(recent, message, botUid);
    const recentTokens = countTokens(recentContextStr);
    const semantic = recentTokens >= cfg.totalTokenBudget
      ? []
      : await retrieveSemantic(chatId, queryText, cfg.semanticTopK);
    const merged = semantic.length > 0
      ? appendExtrasWithinBudget(recent, semantic, message, botUid, cfg.totalTokenBudget)
      : recent;
    const contextStr = slimContextForAI(merged, message, botUid);
    const tokenCount = countTokens(contextStr);

    logger.debug({
      chatId,
      mode: cfg.mode,
      recent: recent.length,
      semantic: semantic.length,
      thread: 0,
      entity: 0,
      merged: merged.length,
      tokenCount,
    }, 'Context retrieved');

    return {
      recent,
      semantic,
      thread: [],
      entity: [],
      merged,
      tokenCount,
    };
  }

  // Run recent first; if it already fills the token budget, skip the expensive semantic fetch
  const recent = await retrieveRecent(chatId, cfg.recentWindow);
  const recentContextStr = slimContextForAI(recent, message, botUid);
  const recentTokens = countTokens(recentContextStr);
  const skipExtras = recentTokens >= cfg.totalTokenBudget;

  if (skipExtras) {
    logger.debug({
      chatId,
      mode: cfg.mode,
      recent: recent.length,
      semantic: 0,
      thread: 0,
      entity: 0,
      merged: recent.length,
      tokenCount: recentTokens,
    }, 'Context retrieved');

    return {
      recent,
      semantic: [],
      thread: [],
      entity: [],
      merged: recent,
      tokenCount: recentTokens,
    };
  }

  // Thread and entity need full message list — only fetch if needed
  const needsAllMessages = !!message.replyTo || (queryText.match(/@\w+/g) ?? []).length > 0;
  const allMessages = needsAllMessages ? await getAll(chatId) : [];

  const [semantic, thread, entity] = await Promise.all([
    retrieveSemantic(chatId, queryText, cfg.semanticTopK),
    retrieveThread(chatId, message, cfg.threadMaxDepth, allMessages),
    retrieveEntity(chatId, message, cfg.entityMaxMessages, allMessages),
  ]);

  // Merge with priority: thread > recent > semantic > entity
  const allMerged = [...thread, ...recent, ...semantic, ...entity];
  const deduped = deduplicateMessages(allMerged);

  // Sort by timestamp
  deduped.sort((a, b) => a.timestamp - b.timestamp);

  // Truncate to token budget
  const merged = appendExtrasWithinBudget(recent, deduped, message, botUid, cfg.totalTokenBudget);
  const contextStr = slimContextForAI(merged, message, botUid);
  const tokenCount = countTokens(contextStr);

  logger.debug({
    chatId,
    mode: cfg.mode,
    recent: recent.length,
    semantic: semantic.length,
    thread: thread.length,
    entity: entity.length,
    merged: merged.length,
    tokenCount,
  }, 'Context retrieved');

  return { recent, semantic, thread, entity, merged, tokenCount };
}
