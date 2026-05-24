import type { Redis } from 'ioredis';
import { logger } from '../shared/logger.js';
import type { AllowlistConfig, AiReviewResult, PendingRequest } from './types.js';
import * as allowlist from './allowlist.js';

const AI_REVIEW_SYSTEM_PROMPT = `你是 Telegram 机器人群组的审核助手。
你将收到一个 JSON，包含以下字段：
- telegram_getchat: 群的元数据（标题、类型、username、简介等）
- recent_group_messages_from_bot_context: 机器人已收录的最近消息摘要
- chat_id, chat_title, applicant_user_id, applicant_username, note

请分析该群是否适合机器人入驻。
输出格式：{"decision":"APPROVE","confidence":0.91,"reason":"群内容正常，讨论氛围友好"}

规则：
- decision: 只能是 APPROVE 或 REJECT
- confidence: 0.0-1.0 之间的浮点数
- 仅在确信群正常、无违规时输出 APPROVE
- 拒绝场景：涉黄赌毒、广告诈骗、黑灰产、刷屏、仇恨言论等
- 如果 telegram_getchat 为 null 且 recent_group_messages_from_bot_context 为空字符串，说明无法获取群组数据，应输出 {"decision":"REJECT","confidence":0.2,"reason":"无法获取群组数据，建议人工审核"}`;

export { AI_REVIEW_SYSTEM_PROMPT };

export function parseAiReviewResult(raw: string): AiReviewResult | null {
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;

    const decision = parsed['decision'];
    if (decision !== 'APPROVE' && decision !== 'REJECT') return null;

    const confidence = Number(parsed['confidence']);
    if (isNaN(confidence) || confidence < 0 || confidence > 1) return null;

    const reason = typeof parsed['reason'] === 'string' ? parsed['reason'] : '';

    return { decision, confidence, reason };
  } catch {
    return null;
  }
}

export function shouldAutoApprove(
  result: AiReviewResult,
  threshold: number,
): boolean {
  return result.decision === 'APPROVE' && result.confidence >= threshold;
}

export async function runAiReview(
  redis: Redis,
  config: AllowlistConfig,
  requestId: string,
  deps: {
    aiCall: (
      systemPrompt: string,
      userMessage: string,
    ) => Promise<string | null>;
    getChat?: (chatId: number) => Promise<unknown>;
    getRecentContext?: (
      chatId: number,
      limit: number,
      maxChars: number,
    ) => Promise<string>;
  },
): Promise<{
  ok: boolean;
  decision?: string;
  confidence?: number;
  reason?: string;
  enabled_now?: boolean;
}> {
  const raw = await redis.hget(`${config.redisPrefix}pending`, requestId);
  if (!raw) return { ok: false };

  const request = JSON.parse(raw) as PendingRequest;

  // Gather context (chatInfo is whatever Telegram returns; just JSON-stringified below)
  let chatInfo: unknown = null;
  if (deps.getChat) {
    try {
      chatInfo = await deps.getChat(request.chat_id);
    } catch (err) {
      logger.warn({ err, chatId: request.chat_id }, 'Failed to getChat for AI review');
    }
  }

  let recentContext = '';
  if (deps.getRecentContext) {
    try {
      recentContext = await deps.getRecentContext(
        request.chat_id,
        config.autoAiReviewMessageLimit,
        config.aiReviewContextMaxChars,
      );
    } catch (err) {
      logger.warn(
        { err, chatId: request.chat_id },
        'Failed to get context for AI review',
      );
    }
  }

  // Build user message
  const userMessage = JSON.stringify({
    telegram_getchat: chatInfo,
    recent_group_messages_from_bot_context: recentContext,
    chat_id: request.chat_id,
    chat_title: request.chat_title,
    applicant_user_id: request.user_id,
    applicant_username: request.username ?? null,
    note: request.note,
  });

  // Call AI
  const aiResponse = await deps.aiCall(AI_REVIEW_SYSTEM_PROMPT, userMessage);
  if (!aiResponse) {
    request.ai_reason = 'AI call failed';
    request.review_state = 'needs_manual';
    await redis.hset(
      `${config.redisPrefix}pending`,
      requestId,
      JSON.stringify(request),
    );
    return { ok: false };
  }

  // Parse result
  const result = parseAiReviewResult(aiResponse);
  if (!result) {
    request.ai_reason = `AI response unparseable: ${aiResponse.slice(0, 200)}`;
    request.review_state = 'needs_manual';
    await redis.hset(
      `${config.redisPrefix}pending`,
      requestId,
      JSON.stringify(request),
    );
    return { ok: false };
  }

  const now = Math.floor(Date.now() / 1000);

  // Update pending request with AI results
  request.ai_decision = result.decision;
  request.ai_confidence = result.confidence;
  request.ai_reason = result.reason;
  request.ai_reviewed_at = now;

  // Auto-approve if confidence meets threshold
  if (shouldAutoApprove(result, config.aiApproveConfidenceThreshold)) {
    request.review_state = 'auto_approved';
    await redis.hset(
      `${config.redisPrefix}pending`,
      requestId,
      JSON.stringify(request),
    );

    const enableNow = config.aiApproveAutoEnable;
    await allowlist.approveRequest(redis, config, requestId, 'ai', enableNow);

    return {
      ok: true,
      decision: result.decision,
      confidence: result.confidence,
      reason: result.reason,
      enabled_now: enableNow,
    };
  }

  // Needs manual review
  request.review_state = 'needs_manual';
  await redis.hset(
    `${config.redisPrefix}pending`,
    requestId,
    JSON.stringify(request),
  );

  return {
    ok: true,
    decision: result.decision,
    confidence: result.confidence,
    reason: result.reason,
  };
}
