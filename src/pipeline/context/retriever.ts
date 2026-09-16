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
import { searchMemory, searchMemoryByUser, type ScoredMessage } from '../../memory/chroma.js';
import type { SelfReply } from '../../tracking/self-history.js';
import { env } from '../../env.js';
import { logger } from '../../shared/logger.js';

// ── Semantic relevance gating ────────────────────────────────
// This is a RECALL-favoring bot (it must remember facts/people), so we keep
// every semantic hit above a modest relevance floor and let topK + the merge
// token-budget cap the volume. The old aggressive 75th-percentile gate (keep
// only the top quartile) silently dropped moderately-relevant facts — e.g. a
// person's 外号 buried among chit-chat — and is disabled here (PERCENTILE=0 ⇒
// the percentile step is a no-op; MIN_SCORE is the real gate that drops junk).
const PERCENTILE = 0.0; // tunable — 0 disables percentile gating (keep-all-above-floor)
const MIN_RESULTS = 3; // tunable — never drop below this many candidates
const MIN_SCORE = 0.2; // tunable — hard floor; only clearly-irrelevant hits are dropped

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

export interface PercentileOptions {
  /** Keep candidates at or above this percentile of the batch's scores (0..1). */
  pct: number;
  /** Never let the surviving set fall below this many candidates. */
  minResults: number;
  /** Hard floor: candidates strictly below this score are always dropped. */
  minScore: number;
}

/**
 * Drop low-relevance candidates by a percentile threshold, defensively.
 *
 * Pure: given items and a score accessor, returns a filtered (order-preserved)
 * subset. Behaviour:
 *  - Candidates with no score (getScore → undefined/NaN) are treated as
 *    unscoreable and pass through unfiltered — keeps the filter a no-op when the
 *    memory layer can't surface scores.
 *  - Among scoreable items, compute the `pct` percentile of their scores and keep
 *    those at/above it. If fewer than `minResults` survive, fall back to the top
 *    `minResults` by score.
 *  - The `minScore` floor is applied last and unconditionally: anything strictly
 *    below it is dropped even if it would otherwise be a top result.
 */
export function filterByPercentile<T>(
  items: readonly T[],
  getScore: (item: T) => number | undefined,
  opts: PercentileOptions,
): T[] {
  if (items.length === 0) return [];

  const scored: { item: T; score: number }[] = [];
  const unscored: T[] = [];
  for (const item of items) {
    const s = getScore(item);
    if (typeof s === 'number' && Number.isFinite(s)) {
      scored.push({ item, score: s });
    } else {
      unscored.push(item);
    }
  }

  // No usable scores → no-op (return everything, original order).
  if (scored.length === 0) return [...items];

  // Percentile threshold over the batch's scores.
  const sortedScores = scored.map((s) => s.score).sort((a, b) => a - b);
  const idx = Math.min(
    sortedScores.length - 1,
    Math.max(0, Math.ceil(opts.pct * sortedScores.length) - 1),
  );
  const threshold = sortedScores[idx]!;

  let kept = scored.filter((s) => s.score >= threshold);

  // Don't starve context: fall back to the top minResults by score.
  if (kept.length < opts.minResults) {
    kept = [...scored]
      .sort((a, b) => b.score - a.score)
      .slice(0, opts.minResults);
  }

  // Hard floor, applied unconditionally and last.
  kept = kept.filter((s) => s.score >= opts.minScore);

  const keptSet = new Set(kept.map((s) => s.item));
  // Preserve original ordering; unscoreable items always pass through.
  return items.filter((item) => keptSet.has(item) || unscored.includes(item));
}

/**
 * Path 2: Semantic search — long-term memory via ChromaDB.
 * Hard 500ms timeout, returns [] on failure or timeout.
 * Applies a percentile relevance gate before the results reach the merge step.
 */
async function retrieveSemantic(
  chatId: number,
  query: string,
  topK: number,
): Promise<FormattedMessage[]> {
  const raw: ScoredMessage[] = await searchMemory(chatId, query, topK, 500);

  // Importance ranking boost: memories recalled often before rank higher now.
  let getScore = (m: ScoredMessage): number | undefined => m.score;
  try {
    const { getRefCounts, REFERENCE_BOOST } = await import('../../memory/importance.js');
    const refs = getRefCounts(raw.map((m) => `${chatId}_${m.messageId}`));
    getScore = (m) => (typeof m.score === 'number'
      ? m.score * (1 + REFERENCE_BOOST * Math.log1p(refs.get(`${chatId}_${m.messageId}`) ?? 0))
      : m.score);
  } catch { /* boost is best-effort */ }

  const kept = filterByPercentile(raw, getScore, {
    pct: PERCENTILE,
    minResults: MIN_RESULTS,
    minScore: MIN_SCORE,
  });

  // Record that these memories were actually recalled (feeds importance + forgetting).
  if (kept.length > 0) {
    import('../../memory/importance.js')
      .then(({ recordMemoryReferenced }) => recordMemoryReferenced(kept.map((m) => `${chatId}_${m.messageId}`)))
      .catch(() => {});
  }
  return kept;
}

/**
 * 机制4:跨上下文人物记忆 —— 召回**锚点用户**在别的场景(群/DM)说过的、经
 * visibility scrub 后可跨界的内容(默认 public + 非私密来源 contextual)。
 * fail-closed:必须 MEMORY_CROSS_CONTEXT_ENABLED && MEMORY_VISIBILITY_ENABLED 同开。
 */
async function retrieveCrossContext(
  chatId: number,
  message: FormattedMessage,
  query: string,
  topK: number,
): Promise<ScoredMessage[]> {
  const e = env();
  if (!e.MEMORY_CROSS_CONTEXT_ENABLED || !e.MEMORY_VISIBILITY_ENABLED) return [];
  // 只对**真实用户**做 per-person 跨上下文召回。负数 uid 是 Telegram sender_chat
  // (匿名管理员 / 频道身份发言)——它把不同的匿名管理员、链接频道全塞进同一个
  // "uid" 桶,当成"同一个人"跨群召回是错的(实况观察发现)。真实用户 uid 恒为正。
  if (!message.uid || message.uid <= 0 || message.isBot) return [];
  // searchMemoryByUser 内部已按 uid 检索 + 剔除同会话(#7)+ 强制 scrubMemoryHits。
  const hits = await searchMemoryByUser(message.uid, query, chatId, topK, 500);
  // 可观测性:这条特性只在真正召回到"别处说过的"内容时才 info 打点(不刷屏),
  // 便于在生产(LOG_LEVEL=info)确认 DM↔群记忆连结在灰度群里真的生效了。
  if (hits.length > 0) {
    logger.info(
      {
        chatId,
        uid: message.uid,
        recalled: hits.length,
        fromChats: [...new Set(hits.map((h) => h.sourceChatId))],
        sample: (hits[0]?.textContent ?? '').slice(0, 40),
      },
      'cross-context memory recalled',
    );
  }
  return hits;
}

/**
 * review #3/#5/#6:跨上下文命中**绝不进 merged**(那会带着别的会话的 per-chat
 * messageId 进当前会话的消息流 → 与本会话 id 碰撞被 dedup 静默丢弃、被模型选作
 * reply/react 目标、被当成本会话发言参与复读链等启发式)。改渲染成一个**独立、
 * 无 #id、明确"别处说的仅参考"** 的块,追加到 contextStr;模型看得到但无法 quote。
 */
function formatCrossContextBlock(hits: ScoredMessage[], botUid: number): string | undefined {
  const rows = hits
    .filter((m) => (m.textContent || '').trim() && m.uid !== botUid)
    .slice(0, 6)
    .map((m) => `- ${m.fullName || m.username || 'TA'}(在别的群/私聊):${(m.textContent || '').slice(0, 80)}`);
  if (rows.length === 0) return undefined;
  return (
    `[TA在别处说过的 · 仅供你了解这个人,不是本场景的消息,**不要**引用/回复这些条目]\n` +
    rows.join('\n')
  );
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
 * 机制5:bot 自己的历史立场(Opus 评审 #3)—— 检索本群自己说过的、
 * 与当前话题相关的发言(翻旧账/自洽能力)。轻量实现:SQLite 关键词重叠
 * 打分,无 embedding 调用;fail-soft 返回 []。
 */
export async function retrieveOwnHistory(
  chatId: number,
  query: string,
  topK = 3,
  withinDays = 30,
): Promise<SelfReply[]> {
  try {
    const { getDb } = await import('../../db/sqlite.js');
    const tokens = (query || '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 2)
      .slice(0, 8);
    if (!tokens.length) return [];
    const db = getDb();
    const cutoff = Math.floor(Date.now() / 1000) - withinDays * 86400;
    const rows = db
      .prepare(
        `SELECT reply_text AS text, ts FROM self_replies
         WHERE chat_id = ? AND ts >= ? ORDER BY ts DESC, id DESC LIMIT 200`,
      )
      .all(chatId, cutoff) as { text: string; ts: number }[];
    // 关键词重叠打分:每个词出现 +1;取 topK。
    const scored = rows
      .map((r) => {
        const lower = (r.text || '').toLowerCase();
        let hits = 0;
        for (const t of tokens) if (lower.includes(t)) hits += 1;
        return { ...r, hits };
      })
      .filter((r) => r.hits > 0)
      .sort((a, b) => b.hits - a.hits || b.ts - a.ts)
      .slice(0, topK);
    return scored.map(({ text, ts }) => ({ text, ts }));
  } catch {
    return [];
  }
}

/** 格式化为独立参考块(不进 merged,防污染回复目标)。 */
export function formatOwnHistoryBlock(own: SelfReply[]): string {
  if (!own.length) return '';
  const lines = own.map((r) => {
    const dt = new Date(r.ts * 1000);
    const stamp = `${dt.getMonth() + 1}/${dt.getDate()}`;
    const text = r.text.length > 80 ? r.text.slice(0, 80) + '…' : r.text;
    return `- ${stamp}: ${text}`;
  });
  return `【你自己之前说过的相关的话】\n${lines.join('\n')}\n保持一致,不要自相矛盾;如果发现前后矛盾,可以自然地承认或圆回来。`;
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
  const e = env();
  const queryText = message.textContent || message.captionContent || '';

  if (cfg.mode === 'direct') {
    const recent = await retrieveRecent(chatId, cfg.recentWindow);
    const recentContextStr = slimContextForAI(recent, message, botUid);
    const recentTokens = countTokens(recentContextStr);
    const overBudget = recentTokens >= cfg.totalTokenBudget;
    const [semantic, crossContext, ownHistory] = await Promise.all([
      overBudget ? Promise.resolve([] as FormattedMessage[]) : retrieveSemantic(chatId, queryText, cfg.semanticTopK),
      // 机制4:DM(direct 模式常是私聊)里也召回该用户在别处说过的可跨界内容
      // (如"我上次在群里说的那个X")。gated + 已 scrub。
      overBudget ? Promise.resolve([] as FormattedMessage[]) : retrieveCrossContext(chatId, message, queryText, cfg.semanticTopK),
      // 机制5:bot 自己的历史相关发言(翻旧账)。独立参考块,不进 merged。
      !e.OWN_HISTORY_RETRIEVAL_ENABLED || overBudget
        ? Promise.resolve([] as { text: string; ts: number }[])
        : retrieveOwnHistory(chatId, queryText, 3),
    ]);
    // crossContext 不进 merged(同 planned 模式);作为独立参考块追加。
    const merged = semantic.length > 0
      ? appendExtrasWithinBudget(recent, semantic, message, botUid, cfg.totalTokenBudget)
      : recent;
    const crossBlock = formatCrossContextBlock(crossContext, botUid);
    const ownBlock = formatOwnHistoryBlock(ownHistory);
    const extraBlock = [crossBlock, ownBlock].filter(Boolean).join('\n\n');
    const contextStr = extraBlock
      ? `${slimContextForAI(merged, message, botUid)}\n\n${extraBlock}`
      : slimContextForAI(merged, message, botUid);
    const tokenCount = countTokens(contextStr);

    logger.debug({
      chatId,
      mode: cfg.mode,
      recent: recent.length,
      semantic: semantic.length,
      crossContext: crossContext.length,
      ownHistory: ownHistory.length,
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
      crossContext,
      ownHistory,
      merged,
      tokenCount,
      contextStr,
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
      contextStr: recentContextStr,
    };
  }

  // Thread and entity need full message list — only fetch if needed
  const needsAllMessages = !!message.replyTo || (queryText.match(/@\w+/g) ?? []).length > 0;
  const allMessages = needsAllMessages ? await getAll(chatId) : [];

  const [semantic, thread, entity, crossContext, ownHistory] = await Promise.all([
    retrieveSemantic(chatId, queryText, cfg.semanticTopK),
    retrieveThread(chatId, message, cfg.threadMaxDepth, allMessages),
    retrieveEntity(chatId, message, cfg.entityMaxMessages, allMessages),
    retrieveCrossContext(chatId, message, queryText, cfg.semanticTopK),
    // 机制5:bot 自己的历史相关发言(翻旧账)。独立参考块,不进 merged。
    !e.OWN_HISTORY_RETRIEVAL_ENABLED
      ? Promise.resolve([] as { text: string; ts: number }[])
      : retrieveOwnHistory(chatId, queryText, 3),
  ]);

  // Merge with priority: thread > recent > semantic > entity。
  // 注意:crossContext **不进** allMerged(见 formatCrossContextBlock,防 id 碰撞/
  // 误当回复目标/污染复读链启发式),而是作为独立参考块追加到 contextStr 末尾。
  const allMerged = [...thread, ...recent, ...semantic, ...entity];
  const deduped = deduplicateMessages(allMerged);

  // Sort by timestamp
  deduped.sort((a, b) => a.timestamp - b.timestamp);

  // Truncate to token budget
  const merged = appendExtrasWithinBudget(recent, deduped, message, botUid, cfg.totalTokenBudget);
  const crossBlock = formatCrossContextBlock(crossContext, botUid);
  const ownBlock = formatOwnHistoryBlock(ownHistory);
  const extraBlock = [crossBlock, ownBlock].filter(Boolean).join('\n\n');
  const contextStr = extraBlock
    ? `${slimContextForAI(merged, message, botUid)}\n\n${extraBlock}`
    : slimContextForAI(merged, message, botUid);
  const tokenCount = countTokens(contextStr);

  logger.debug({
    chatId,
    mode: cfg.mode,
    recent: recent.length,
    semantic: semantic.length,
    thread: thread.length,
    entity: entity.length,
    crossContext: crossContext.length,
    ownHistory: ownHistory.length,
    merged: merged.length,
    tokenCount,
  }, 'Context retrieved');

  return { recent, semantic, thread, entity, crossContext, ownHistory, merged, tokenCount, contextStr };
}
