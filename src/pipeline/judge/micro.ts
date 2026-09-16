// ────────────────────────────────────────
// L1 Micro model judge
// ────────────────────────────────────────

import { resolveReplyPath } from '../../shared/types.js';
import type { FormattedMessage, JudgeAction, JudgeResult, ReplyPath } from '../../shared/types.js';
import type { AICallResult } from '../../ai/types.js';
import { callWithFallback } from '../../ai/fallback.js';
import { slimContextForAI } from '../context/slim.js';
import { loadPrompt } from '../../shared/config.js';
import { getConfig } from '../../shared/config.js';
import { logger } from '../../shared/logger.js';
import { AIConfigError } from '../../shared/errors.js';

const VALID_ACTIONS = new Set(['REPLY', 'IGNORE', 'REJECT'] as const);
type RawJudgeAction = 'REPLY' | 'IGNORE' | 'REJECT';
const VALID_REPLY_PATHS = new Set<ReplyPath>(['direct', 'planned']);

function parseReplyPath(raw: unknown): ReplyPath | undefined {
  if (typeof raw !== 'string') return undefined;
  const normalized = raw.toLowerCase();
  if (!VALID_REPLY_PATHS.has(normalized as ReplyPath)) return undefined;
  return normalized as ReplyPath;
}

function normalizeJudgeDecision(
  actionRaw: string,
  replyPath?: ReplyPath,
): { action: JudgeAction; replyPath?: ReplyPath } | null {
  const normalizedAction = actionRaw.toUpperCase();
  // Legacy tier actions (REPLY_PRO / REPLY_MAX): model may still emit them from a cached prompt.
  // Tier system removed — degrade gracefully to plain REPLY instead of parse failure.
  if (normalizedAction === 'REPLY_PRO' || normalizedAction === 'REPLY_MAX') {
    return {
      action: 'REPLY',
      replyPath: 'planned',
    };
  }

  if (!VALID_ACTIONS.has(normalizedAction as RawJudgeAction)) {
    return null;
  }

  const action = normalizedAction as JudgeAction;
  return {
    action,
    replyPath: resolveReplyPath(action, replyPath),
  };
}

export function parseJudgeAction(raw: string): { action: JudgeAction; replyPath?: ReplyPath; confidence: number; reasoning: string } | null {
  // Strip markdown code blocks + reasoning 模型的 thinking 块(StepFun 只回 thinking
  // 不带 text 时 provider 层已剥成对块; 这里再防未闭合前缀/残留块, 与 syco 同口径)。
  // 线上 judge parse 失败极少(1/全量), 但 thinking 残留会让"含 REPLY 关键词"的
  // fallback 误判 —— 先剥干净再走原有三级解析(顺序不变)。
  let cleaned = (raw ?? '').trim();
  cleaned = cleaned
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .replace(/^[\s\S]*?<\/think(?:ing)?>/gi, '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  // Try JSON parse first
  try {
    const parsed = JSON.parse(cleaned) as Record<string, unknown>;
    const action = (parsed['action'] ?? parsed['ACTION']) as string | undefined;
    if (action) {
      const replyPath = parseReplyPath(parsed['replyPath'] ?? parsed['reply_path'] ?? parsed['REPLY_PATH']);
      const decision = normalizeJudgeDecision(action, replyPath);
      if (!decision) return null;
      return {
        action: decision.action,
        replyPath: decision.replyPath,
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
    const decision = normalizeJudgeDecision(
      jsonMatch[1],
      parseReplyPath(replyPathMatch?.[1]),
    );
    if (!decision) return null;
    return {
      action: decision.action,
      replyPath: decision.replyPath,
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
  signal?: AbortSignal,
  burstHint?: string,
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
          content: `${kbBlock}${chatId !== undefined && chatId > 0 ? '私聊' : '群聊'}上下文:\n${contextStr}\n\n${burstHint ? `${burstHint}\n\n` : ''}请对最新一条消息(★标记)做出决策。`,
        },
      ],
      maxTokens: 100,
      temperature: 0,
      // judge.md 要求只输出 JSON 对象 —— usage 级 jsonMode 已默认开（H4.2），
      // 这里不再逐个传，provider 层 response_format 兜底。
      signal,
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
    level: 'L1_MICRO',
    confidence: parsed.confidence,
    reasoning: parsed.reasoning,
    latencyMs,
  };
}
