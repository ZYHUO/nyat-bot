import { getRedis } from '../db/redis.js';
import type { FormattedMessage, ReplyPath } from '../shared/types.js';
import { detectPathPatterns, type PathPattern } from './path-patterns.js';
import { reviewPathDecision } from './path-reflection.js';

const PATH_POLICY_PREFIX = 'xxb:path-policy:';
const PATH_POLICY_TTL_SECONDS = 7 * 24 * 60 * 60;
const PATTERN_PRIORITY: PathPattern[] = [
  'followup_lookup',
  'link_inspect',
  'market_quote',
  'realtime_info',
];
const MIN_SCORE = -3;
const MAX_SCORE = 3;

function policyKey(chatId: number): string {
  return `${PATH_POLICY_PREFIX}${chatId}`;
}

function parsePolicyScore(raw: string | undefined): number | null {
  if (!raw) return null;
  if (raw === 'planned') return 1;
  if (raw === 'direct') return -2;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function scoreToReplyPath(score: number): ReplyPath | null {
  if (score >= 1) return 'planned';
  if (score <= -2) return 'direct';
  return null;
}

function clampScore(score: number): number {
  return Math.max(MIN_SCORE, Math.min(MAX_SCORE, score));
}

export async function applyChatPathPolicy(input: {
  chatId: number;
  message: FormattedMessage;
  botUid: number;
  rawReplyPath: ReplyPath;
}): Promise<{ replyPath: ReplyPath; matchedPatterns: string[]; source: 'raw' | 'policy' }> {
  const matchedPatterns = detectPathPatterns(input.message, input.botUid);
  if (matchedPatterns.length === 0) {
    return {
      replyPath: input.rawReplyPath,
      matchedPatterns,
      source: 'raw',
    };
  }

  const stored = await getRedis().hgetall(policyKey(input.chatId));
  const orderedPatterns = [...matchedPatterns].sort(
    (a, b) => PATTERN_PRIORITY.indexOf(a as PathPattern) - PATTERN_PRIORITY.indexOf(b as PathPattern),
  );
  for (const pattern of orderedPatterns) {
    const score = parsePolicyScore(stored[pattern]);
    if (score === null) continue;
    const replyPath = scoreToReplyPath(score);
    if (replyPath) {
      return {
        replyPath,
        matchedPatterns,
        source: 'policy',
      };
    }
  }

  return {
    replyPath: input.rawReplyPath,
    matchedPatterns,
    source: 'raw',
  };
}

export async function reflectChatPathPolicy(input: {
  chatId: number;
  message: FormattedMessage;
  botUid: number;
  effectiveReplyPath: ReplyPath;
  replyText: string;
  toolsUsed: string[];
  toolExecutionFailed: boolean;
}): Promise<void> {
  const matchedPatterns = detectPathPatterns(input.message, input.botUid);
  if (matchedPatterns.length === 0) return;
  if (input.toolExecutionFailed) return;

  const redis = getRedis();
  const key = policyKey(input.chatId);
  const stored = await redis.hgetall(key);

  const reflection = await reviewPathDecision({
    messageText: input.message.textContent || input.message.captionContent || '',
    replyText: input.replyText,
    effectiveReplyPath: input.effectiveReplyPath,
    matchedPatterns,
    toolsUsed: input.toolsUsed,
    toolExecutionFailed: input.toolExecutionFailed,
  }).catch(() => null);

  if (!reflection?.shouldLearn || reflection.confidence < 0.75) return;
  if (!matchedPatterns.includes(reflection.pattern)) return;

  const delta =
    reflection.targetReplyPath === 'planned'
      ? (input.effectiveReplyPath === 'planned' && input.toolsUsed.length === 0 ? 0 : 1)
      : -1;

  const currentScore = parsePolicyScore(stored[reflection.pattern]) ?? 0;
  const nextScore = clampScore(currentScore + delta);
  await redis.hset(key, reflection.pattern, String(nextScore));
  await redis.expire(key, PATH_POLICY_TTL_SECONDS);
}
