// ────────────────────────────────────────
// Turn Actor — 已回应消息追踪(G7 回访未回应消息)
// ────────────────────────────────────────
//
// bot 每次发出回复时把 targetMessageId 标记为「已回应」;回合开火时
// 从最近上下文里筛出「没回应过、还新鲜、看起来值得接」的人类消息,
// 注入 ≤2 条候选给写手——模型自己决定要不要顺带圆回去(scroll-up
// "对了你刚才问的那个…"),不合适就忽略。
//
// 存储:Redis sorted set xxb:turn:answered:{chatId},score = 回应时刻。
// 只保留 24h,集合本身有 TTL,体积可控。

import { getRedis } from '../../db/redis.js';
import type { FormattedMessage } from '../../shared/types.js';

const ANSWERED_KEY = (chatId: number) => `xxb:turn:answered:${chatId}`;
const RETENTION_MS = 24 * 60 * 60 * 1000;
const KEY_TTL_SEC = 48 * 60 * 60;

/** 候选回访窗口:消息超过这个年龄就不值得翻旧账了 */
const REVISIT_MAX_AGE_SEC = 30 * 60;

export async function markAnswered(chatId: number, messageIds: number[]): Promise<void> {
  if (messageIds.length === 0) return;
  const redis = getRedis();
  const now = Date.now();
  const key = ANSWERED_KEY(chatId);
  const args: Array<string | number> = [];
  for (const id of messageIds) {
    args.push(now, String(id));
  }
  const multi = redis.multi();
  multi.zadd(key, ...(args as [number, string]));
  multi.zremrangebyscore(key, 0, now - RETENTION_MS);
  multi.expire(key, KEY_TTL_SEC);
  await multi.exec();
}

async function filterUnanswered(chatId: number, ids: number[]): Promise<Set<number>> {
  if (ids.length === 0) return new Set();
  const redis = getRedis();
  const scores = await redis.zmscore(ANSWERED_KEY(chatId), ...ids.map(String));
  const unanswered = new Set<number>();
  ids.forEach((id, i) => {
    if (scores[i] === null) unanswered.add(id);
  });
  return unanswered;
}

export interface RevisitCandidate {
  messageId: number;
  sender: string;
  snippet: string;
}

/**
 * Pick ≤`limit` recent human messages worth circling back to:
 * unanswered, fresh (≤30min), not in the current burst, and substantive
 * (a question, or long enough to carry a topic).
 */
export async function pickRevisitCandidates(
  chatId: number,
  recentMessages: FormattedMessage[],
  excludeIds: number[],
  botUid: number,
  limit = 2,
): Promise<RevisitCandidate[]> {
  const now = Math.floor(Date.now() / 1000);
  const exclude = new Set(excludeIds);

  const eligible = recentMessages.filter((m) => {
    if (m.role === 'assistant' || m.isBot || m.uid === botUid) return false;
    if (!m.messageId || exclude.has(m.messageId)) return false;
    if (m.timestamp < now - REVISIT_MAX_AGE_SEC) return false;
    const text = (m.textContent || m.captionContent || '').trim();
    if (!text) return false;
    // Substantive: an actual question, or long enough to carry a topic
    return /[??]/.test(text) || text.length >= 12;
  });
  if (eligible.length === 0) return [];

  const unanswered = await filterUnanswered(
    chatId,
    eligible.map((m) => m.messageId),
  );

  return eligible
    .filter((m) => unanswered.has(m.messageId))
    .slice(-limit)
    .map((m) => ({
      messageId: m.messageId,
      sender: m.fullName || m.username || String(m.uid),
      snippet: (m.textContent || m.captionContent || '').slice(0, 80),
    }));
}
