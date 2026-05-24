// ────────────────────────────────────────
// L1 Micro model judge
// ────────────────────────────────────────

import { resolveReplyPath, resolveReplyTier } from '../../shared/types.js';
import type { FormattedMessage, JudgeAction, JudgeResult, ReplyPath, ReplyTier } from '../../shared/types.js';
import type { AICallResult } from '../../ai/types.js';
import { callWithFallback } from '../../ai/fallback.js';
import { slimContextForAI } from '../context/slim.js';
import { loadPrompt } from '../../shared/config.js';
import { getConfig } from '../../shared/config.js';
import { logger } from '../../shared/logger.js';
import { AIConfigError } from '../../shared/errors.js';

const VALID_ACTIONS = new Set(['REPLY', 'REPLY_PRO', 'REPLY_MAX', 'IGNORE', 'REJECT'] as const);
type RawJudgeAction = 'REPLY' | 'REPLY_PRO' | 'REPLY_MAX' | 'IGNORE' | 'REJECT';
const VALID_REPLY_PATHS = new Set<ReplyPath>(['direct', 'planned']);
const VALID_REPLY_TIERS = new Set<ReplyTier>(['normal', 'pro', 'max']);

function parseReplyPath(raw: unknown): ReplyPath | undefined {
  if (typeof raw !== 'string') return undefined;
  const normalized = raw.toLowerCase();
  if (!VALID_REPLY_PATHS.has(normalized as ReplyPath)) return undefined;
  return normalized as ReplyPath;
}

function parseReplyTier(raw: unknown): ReplyTier | undefined {
  if (typeof raw !== 'string') return undefined;
  const normalized = raw.toLowerCase();
  if (!VALID_REPLY_TIERS.has(normalized as ReplyTier)) return undefined;
  return normalized as ReplyTier;
}

function normalizeJudgeDecision(
  actionRaw: string,
  replyPath?: ReplyPath,
  replyTier?: ReplyTier,
): { action: JudgeAction; replyPath?: ReplyPath; replyTier?: ReplyTier } | null {
  const normalizedAction = actionRaw.toUpperCase();
  if (normalizedAction === 'REPLY_PRO') {
    return {
      action: 'REPLY',
      replyPath: 'planned',
      replyTier: 'pro',
    };
  }

  if (normalizedAction === 'REPLY_MAX') {
    return {
      action: 'REPLY',
      replyPath: 'planned',
      replyTier: 'max',
    };
  }

  if (!VALID_ACTIONS.has(normalizedAction as RawJudgeAction)) {
    return null;
  }

  const action = normalizedAction as JudgeAction;
  return {
    action,
    replyPath: resolveReplyPath(action, replyPath),
    replyTier: resolveReplyTier(action, replyTier),
  };
}

export function parseJudgeAction(raw: string): { action: JudgeAction; replyPath?: ReplyPath; replyTier?: ReplyTier; confidence: number; reasoning: string } | null {
  // Strip markdown code blocks
  let cleaned = raw.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  cleaned = cleaned.trim();

  // Try JSON parse first
  try {
    const parsed = JSON.parse(cleaned) as Record<string, unknown>;
    const action = (parsed['action'] ?? parsed['ACTION']) as string | undefined;
    if (action && VALID_ACTIONS.has(action.toUpperCase() as RawJudgeAction)) {
      const replyPath = parseReplyPath(parsed['replyPath'] ?? parsed['reply_path'] ?? parsed['REPLY_PATH']);
      const replyTier = parseReplyTier(parsed['replyTier'] ?? parsed['reply_tier'] ?? parsed['REPLY_TIER']);
      const decision = normalizeJudgeDecision(action, replyPath, replyTier);
      if (!decision) return null;
      return {
        action: decision.action,
        replyPath: decision.replyPath,
        replyTier: decision.replyTier,
        confidence: typeof parsed['confidence'] === 'number' ? parsed['confidence'] : 0.5,
        reasoning: typeof parsed['reasoning'] === 'string' ? parsed['reasoning'] : '',
      };
    }
  } catch {
    // not valid JSON
  }

  // Try regex for {"ACTION": "REPLY"} style
  const jsonMatch = cleaned.match(/"(?:action|ACTION)"\s*:\s*"(REPLY_MAX|REPLY_PRO|REPLY|IGNORE|REJECT)"/i);
  if (jsonMatch?.[1]) {
    const replyPathMatch = cleaned.match(/"(?:replyPath|reply_path|REPLY_PATH)"\s*:\s*"(direct|planned)"/i);
    const replyTierMatch = cleaned.match(/"(?:replyTier|reply_tier|REPLY_TIER)"\s*:\s*"(normal|pro|max)"/i);
    const decision = normalizeJudgeDecision(
      jsonMatch[1],
      parseReplyPath(replyPathMatch?.[1]),
      parseReplyTier(replyTierMatch?.[1]),
    );
    if (!decision) return null;
    return {
      action: decision.action,
      replyPath: decision.replyPath,
      replyTier: decision.replyTier,
      confidence: 0.5,
      reasoning: '',
    };
  }

  // Try keyword extraction
  const upper = cleaned.toUpperCase();
  for (const kw of ['REPLY_MAX', 'REPLY_PRO', 'REPLY', 'IGNORE', 'REJECT'] as const) {
    if (upper.includes(kw)) {
      const decision = normalizeJudgeDecision(kw);
      if (!decision) return null;
      return {
        action: decision.action,
        replyPath: decision.replyPath,
        replyTier: decision.replyTier,
        confidence: 0.3,
        reasoning: '',
      };
    }
  }

  return null;
}

export async function microJudge(
  message: FormattedMessage,
  recentMessages: FormattedMessage[],
  botUid: number,
  usage = 'judge',
  knowledgeBase?: string,
  chatId?: number,
): Promise<JudgeResult> {
  const start = performance.now();
  const config = getConfig();
  const systemPrompt = loadPrompt('task/judge.md', config.promptsDir);
  const contextStr = slimContextForAI(recentMessages, message, botUid);
  const kbBlock =
    knowledgeBase && knowledgeBase.trim()
      ? `[知识库]\n${knowledgeBase.trim()}\n\n`
      : '';

  let result: AICallResult;
  try {
    result = await callWithFallback({
      usage,
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: `${kbBlock}${chatId !== undefined && chatId > 0 ? '私聊' : '群聊'}上下文:\n${contextStr}\n\n请对最新一条消息(★标记)做出决策。`,
        },
      ],
      maxTokens: 100,
      temperature: 0,
    });
  } catch (err) {
    if (err instanceof AIConfigError) {
      logger.error({ err }, 'Micro judge routing misconfigured');
      throw err;
    }
    logger.error({ err }, 'Micro judge AI call failed, defaulting to IGNORE');
    return {
      action: 'IGNORE',
      level: 'L1_MICRO',
      confidence: 0,
      reasoning: 'AI call failed',
      latencyMs: Math.round(performance.now() - start),
    };
  }

  const parsed = parseJudgeAction(result.content);
  const latencyMs = Math.round(performance.now() - start);

  if (!parsed) {
    logger.warn({ raw: result.content, parseFailure: true }, 'Failed to parse judge response, defaulting to IGNORE');
    return {
      action: 'IGNORE',
      level: 'L1_MICRO',
      confidence: 0,
      reasoning: 'parse_failed',
      latencyMs,
    };
  }

  return {
    action: parsed.action,
    replyPath: parsed.replyPath,
    replyTier: parsed.replyTier,
    level: 'L1_MICRO',
    confidence: parsed.confidence,
    reasoning: parsed.reasoning,
    latencyMs,
  };
}
