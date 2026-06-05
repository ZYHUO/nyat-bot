// ────────────────────────────────────────
// Reply Orchestrator — generate reply via AI
// ────────────────────────────────────────

import { resolveReplyPath, resolveReplyTier } from '../../shared/types.js';
import type { FormattedMessage, RetrievedContext, ReplyOutput, ReplyPath, ReplyTier } from '../../shared/types.js';
import type { JudgeAction } from '../../shared/types.js';
import { callWithFallback } from '../../ai/fallback.js';
import { AIError } from '../../shared/errors.js';
import { buildSystemPrompt, buildMessages } from './prompt-builder.js';
import { slimContextForAI } from '../context/slim.js';
import { searchKnowledge } from '../../knowledge/manager.js';
import { getToolNames } from '../tools/registry.js';
import { parseReplyResponse } from './parser.js';
import { segmentReply, type SegmenterConfig } from './segmenter.js';
import { getRecent, getGroupMembers } from '../context/manager.js';
import { doCheckin, getCheckinStats } from '../checkin.js';
import { getBotTracker } from '../../tracking/interaction.js';
import { getUserProfilePrompt, getUserPreferences } from '../../tracking/user-profile.js';
import { getReflection } from '../../tracking/outcome.js';
import { planReply } from '../planner/planner.js';
import { detectCommandIntent } from '../nl-commands.js';
import { executeToolPlan, formatToolResultsForPrompt } from '../planner/executor.js';
import { countTokens } from '../../ai/token-counter.js';
import { logger } from '../../shared/logger.js';
import { getCachedRoster, setCachedRoster } from './member-cache.js';

const MAX_DUPLICATE_RETRIES = 1;
const MAX_MULTI_REPLY_RETRIES = 1;
const MAX_TOOL_ARTIFACT_RETRIES = 1;
const REPLY_SPLITTER_CHAR_THRESHOLD = 60; // 短回复(<60字)不分段，保持单条（之前 20，几乎都被切）
const REPLY_CONTEXT_BUDGET: Record<ReplyTier, number> = {
  normal: 48_000,
  pro: 72_000,
  max: 100_000,
};

async function generateReplyModelOutput(
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  usage: string,
  opts?: { temperatureOverride?: number; signal?: AbortSignal },
) {
  const result = await callWithFallback({
    usage,
    messages,
    temperature: opts?.temperatureOverride,
    signal: opts?.signal,
  });

  // Strip thinking blocks from models that emit them (e.g. gemini thinking tags)
  const content = result.content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

  return {
    ...result,
    content,
    toolsUsed: [] as string[],
  };
}

function containsToolArtifact(text: string): boolean {
  return /<\/?web_search>/i.test(text)
    || /^\s*Search results for\s+["“]/im.test(text)
    || /^\s*\d+\.\s+Title:\s+/im.test(text)
    || /^\s*\[TOOL_RESULTS\]/im.test(text)
    || /(^|\n)\s*tool:\s*[A-Z_]+/m.test(text);
}

function appendToolArtifactRetryInstruction(
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  return messages.map((message, index) => {
    if (index !== messages.length - 1 || message.role !== 'user') return message;
    return {
      ...message,
      content: [
        message.content,
        '[RETRY_INSTRUCTION]',
        '上一次输出泄露了工具原始结果。必须把 [TOOL_RESULTS] 综合成自然语言回复，并严格输出 reply JSON；禁止原样复制 <web_search>、Search results、Title/URL 列表或 [TOOL_RESULTS] 标记。',
      ].join('\n\n'),
    };
  });
}

function detectExactReplyCountRequest(message: FormattedMessage): number | undefined {
  const text = (message.textContent || message.captionContent || '').trim();
  if (!text) return undefined;

  if (/(发我两条|发两条|两条消息|两句|一人一条|分别回|各发一条)/i.test(text)) {
    return 2;
  }

  if (/(发我三条|发三条|三条消息|三句)/i.test(text)) {
    return 3;
  }

  return undefined;
}

/** Normalize text for duplicate comparison (matching PHP behavior) */
function normalizeForDuplicateCheck(text: string): string {
  return text
    .replace(/\s+/g, ' ')       // collapse all whitespace
    .replace(/\n{3,}/g, '\n\n') // compress 3+ newlines to 2
    .trim()
    .toLowerCase();
}

/**
 * Check if reply is a duplicate of recent assistant messages.
 */
async function isDuplicateReply(chatId: number, replyContent: string): Promise<boolean> {
  if (replyContent.length < 20) return false; // short replies are never considered duplicates
  const recent = await getRecent(chatId, 10);
  const recentAssistant = recent
    .filter((m) => m.role === 'assistant')
    .slice(-5); // Increased from 3 to 5 for better duplicate detection

  const normalized = normalizeForDuplicateCheck(replyContent);
  return recentAssistant.some((m) => normalizeForDuplicateCheck(m.textContent) === normalized);
}

/**
 * Generate a reply using AI with proper context.
 */
export async function generateReply(
  message: FormattedMessage,
  retrievedContext: RetrievedContext,
  action: JudgeAction,
  chatId: number,
  botUid: number,
  replyPath?: ReplyPath,
  replyTier?: ReplyTier,
  segmenterConfig?: Partial<SegmenterConfig>,
  callOpts?: {
    signal?: AbortSignal;
    burstIds?: number[];
    revisitCandidates?: Array<{ messageId: number; sender: string; snippet: string }>;
    /** G2: 统一动作空间已启用 — 解析并执行 react/sticker/silent 动作 */
    actionSpace?: boolean;
  },
): Promise<{
  replies: ReplyOutput[];
  toolsUsed: string[];
  toolExecutionFailed: boolean;
  /** G2: model-chosen emoji reactions to execute as first-class acts */
  reactions?: Array<{ targetMessageId: number; emoji: string }>;
  /** G2: the model deliberately chose silence — send nothing, not an error */
  modelSilent?: boolean;
}> {
  const interruptSignal = callOpts?.signal;
  // G4: the turn drained a multi-message burst — tell the writer to answer
  // the whole thought and pick the real anchor, not just the newest line.
  const burstPart = callOpts?.burstIds && callOpts.burstIds.length > 1
    ? `[连发上下文] 这次回复由一波连发触发，共 ${callOpts.burstIds.length} 条：${callOpts.burstIds.map((id) => `#${id}`).join('、')}（按时间顺序，最后一条最新，内容都在上方上下文里）。请把整波连发当作一个完整的念头来回应，不要只回最后一句；targetMessageId 选这一波里真正承载重点的那条（往往是提问/求助的那条，不一定是最后一条）。`
    : undefined;
  // G7: surface still-unanswered recent messages so the model can scroll back
  // ("对了你刚才问的那个…") — strictly optional, the model may ignore them.
  const revisitPart = callOpts?.revisitCandidates && callOpts.revisitCandidates.length > 0
    ? `[未回应的消息] 最近还有几条没人接的消息：\n${callOpts.revisitCandidates.map((c) => `- #${c.messageId} ${c.sender}：${c.snippet}`).join('\n')}\n如果当前话题合适、你也确实有话可说，可以在回复里顺带圆回去（多发一条、targetMessageId 填对应的 id）；不合适就直接忽略，别为了回而回。`
    : undefined;
  const burstHint = [burstPart, revisitPart].filter(Boolean).join('\n\n') || undefined;
  const start = performance.now();
  const effectiveReplyPath = resolveReplyPath(action, replyPath) ?? 'direct';
  const effectiveReplyTier = resolveReplyTier(action, replyTier) ?? 'normal';

  // 1. Build system prompt (5-layer)
  const systemPrompt = buildSystemPrompt(effectiveReplyTier, message.uid, chatId);

  // 2. Compress and format context
  const contextStr = slimContextForAI(retrievedContext.merged, message, botUid);
  const budget = REPLY_CONTEXT_BUDGET[effectiveReplyTier];
  // Fast path: for CJK-heavy content, use ~2 chars/token heuristic
  // Skip expensive tokenizer call if clearly over budget
  const contextTokens = contextStr.length > budget * 2 ? budget : countTokens(contextStr);
  const remainingContextBudget = Math.max(0, budget - contextTokens);

  // 3. Load knowledge (keyword-scoped like PHP searchKnowledge; empty query → full KB)
  const queryText = (message.textContent || message.captionContent || '').trim();
  let knowledge: string | undefined;
  if (remainingContextBudget > 0) {
    const kb = searchKnowledge(chatId, queryText, 5);
    if (kb) {
      const knowledgeTokens = countTokens(kb);
      if (knowledgeTokens <= remainingContextBudget) {
        knowledge = kb;
        logger.debug({
          chatId,
          contextTokens,
          knowledgeTokens,
          remainingBudget: remainingContextBudget - knowledgeTokens,
          budgetUsage: Math.round(((contextTokens + knowledgeTokens) / budget) * 100),
        }, 'Context budget allocation');
      } else {
        logger.debug({
          chatId,
          knowledgeTokens,
          remainingBudget: remainingContextBudget,
        }, 'Knowledge truncated due to budget');
      }
    }
  }

  // 3.5 Checkin data injection — minimal real data, AI creates the rest
  // 频道/匿名身份不能签到（uid 是群/频道 ID，不是真实用户）
  let checkinData: string | undefined;
  const msgText = message.textContent || '';
  // Detect checkin/stats via exact slash command OR natural-language phrasing
  // (e.g. "帮我签到"), so the data is injected even when the bot wasn't formally
  // @addressed — otherwise the reply LLM hallucinates a checkin without the streak.
  const cmdIntent = detectCommandIntent(msgText);
  const isCheckinMsg = /^\/checkin(?:@\w+)?$/i.test(msgText.trim()) || cmdIntent?.cmd === '/checkin';
  const isStatsMsg = /^\/stats(?:@\w+)?$/i.test(msgText.trim()) || cmdIntent?.cmd === '/stats';
  if (isCheckinMsg && message.isAnonymous) {
    // 匿名管理员/频道身份的 uid 是群/频道 ID，不是真实用户，无法签到。
    // 明确告诉 LLM 不要假装签到成功或编造连签数据。
    checkinData = '[签到系统] 对方是匿名管理员/频道身份，无法签到（不是真实用户身份）。请友善但明确地告诉TA：匿名身份不能签到，需要用真实身份发消息再签。绝对不要假装签到成功，也不要编造连签天数或奖励。';
  } else if (isCheckinMsg) {
    try {
      const result = doCheckin(chatId, message.uid, message.username, message.fullName);
      let checkinStr = result.isNew
        ? `[签到系统] 签到成功！连续${result.streak}天，累计${result.totalCheckins}次，今日第${result.rank}个。请自由发挥奖励、运势等有趣内容。`
        : `[签到系统] 今天已经签过了！连续${result.streak}天，累计${result.totalCheckins}次，今日第${result.rank}个。提醒TA别重复签。`;
      if (result.milestone) {
        checkinStr += `\n[里程碑] 连续签到达到${result.milestone}天！请给予特别庆祝和丰厚奖励！`;
      }
      if (result.isNew && result.unlockedCard) {
        const c = result.unlockedCard;
        checkinStr += `\n[猫娘卡] 今天还免费遇到了一只猫娘卡：${c.emoji}${c.star}「${c.name}」（${c.rarity}）${c.isNew ? '，是TA图鉴里的新卡！' : '（重复啦，可以拿去跟群友换）'}。请自然地把这只猫娘卡一起报给TA，可爱地提一句（别说"抽到"，是遇到/解锁），并提示可以 /cards 看图鉴。`;
      }
      checkinData = checkinStr;
      logger.debug({ chatId, uid: message.uid, isNew: result.isNew, streak: result.streak, milestone: result.milestone }, 'Checkin data injected');
    } catch (err) {
      logger.error({ err, chatId }, 'Checkin failed');
    }
  }

  // /stats 排行榜注入
  if (isStatsMsg) {
    try {
      const stats = getCheckinStats(chatId);
      const todayList = stats.todayRank.map(r =>
        `${r.rank}. ${r.fullName}（连签${r.streak}天）`,
      ).join('\n') || '今天还没人签到';
      const allTimeList = stats.allTimeRank.map(r =>
        `${r.rank}. ${r.fullName} ${r.totalCheckins}次`,
      ).join('\n') || '暂无数据';
      checkinData = `[签到排行榜] 今日已签到${stats.todayCount}人\n今日签到顺序：\n${todayList}\n\n历史总签到排行：\n${allTimeList}\n请用可爱的方式展示这个排行榜。`;
      logger.debug({ chatId }, 'Stats data injected');
    } catch (err) {
      logger.error({ err, chatId }, 'Stats failed');
    }
  }

  const useRichContext = effectiveReplyPath === 'planned' || effectiveReplyTier === 'pro' || effectiveReplyTier === 'max';
  const exactReplyCount = detectExactReplyCountRequest(message);

  // 3.6-3.9 Fetch rich context in parallel where possible
  const memberRosterPromise = (useRichContext && chatId < 0)
    ? (async () => {
      // Check cache first
      const cached = getCachedRoster(chatId);
      if (cached) return cached;

      try {
        const members = await getGroupMembers(chatId);
        if (members.length === 0) return undefined;
        const roster = members.slice(0, 50).map(m => {
          const tag = m.username ? `@${m.username}` : `uid:${m.uid}`;
          return `${tag} = ${m.fullName}`;
        }).join('\n');

        // Cache for 5 minutes
        setCachedRoster(chatId, roster);
        return roster;
      } catch (err) {
        logger.debug({ err, chatId }, 'Failed to fetch member roster (non-critical)');
        return undefined;
      }
    })()
    : Promise.resolve(undefined);

  // Bot knowledge, user profile, preferences, self-reflection are all sync — compute directly
  let botKnowledge: string | undefined;
  if (useRichContext && chatId < 0) {
    try {
      const tracker = getBotTracker();
      if (tracker) {
        const contextForBotScan = retrievedContext.merged.map(m => ({
          isBot: m.isBot,
          botUsername: m.isBot ? m.username : undefined,
        }));
        const knowledge_str = tracker.getKnowledgeForReply(chatId, contextForBotScan);
        if (knowledge_str) botKnowledge = knowledge_str;
      }
    } catch (err) {
      logger.debug({ err, chatId }, 'Failed to fetch bot knowledge (non-critical)');
    }
  }

  let userProfile: string | undefined;
  if ((useRichContext || chatId > 0) && !message.isBot && !message.isAnonymous) {
    try {
      userProfile = getUserProfilePrompt(chatId, message.uid) ?? undefined;
    } catch (err) {
      logger.debug({ err, chatId }, 'Failed to fetch user profile (non-critical)');
    }
  }

  let userPreferences: string | undefined;
  if (!message.isBot && !message.isAnonymous) {
    try {
      userPreferences = getUserPreferences(chatId, message.uid) ?? undefined;
    } catch (err) {
      logger.debug({ err, chatId }, 'Failed to fetch user preferences (non-critical)');
    }
  }

  let selfReflection: string | undefined;
  if (useRichContext) {
    try {
      selfReflection = getReflection(chatId) ?? undefined;
    } catch (err) {
      logger.debug({ err, chatId }, 'Failed to fetch self-reflection (non-critical)');
    }
  }

  // Await the only truly async fetch
  const memberRoster = await memberRosterPromise;

  // 4. Build messages array
  let toolResultsBlock: string | undefined;
  const usage = effectiveReplyTier === 'max' ? 'reply_max'
    : effectiveReplyTier === 'pro' ? 'reply_pro'
    : 'reply';
  let toolsUsed: string[] = [];
  let toolExecutionFailed = false;

  if (effectiveReplyPath === 'planned') {
    const availableTools = getToolNames(chatId, message.uid);
    const plan = await planReply({
      usage,
      messageText: queryText,
      context: contextStr,
      knowledge,
      availableTools,
    });

    if (plan.needTools && plan.steps.length > 0) {
      let attempt = 0;
      while (attempt <= 1) {
        try {
          const executedSteps = await executeToolPlan(plan, { chatId, userId: message.uid });
          toolsUsed = executedSteps.map((step) => step.tool);
          toolResultsBlock = formatToolResultsForPrompt(executedSteps);
          break;
        } catch (err) {
          attempt++;
          if (attempt > 1) {
            toolExecutionFailed = true;
            logger.warn({ err, chatId, plan }, 'Tool plan execution failed after retry');
          } else {
            logger.warn({ err, chatId }, 'Tool plan execution failed, retrying once');
          }
        }
      }
      if (toolExecutionFailed) {
        return {
          replies: [{
            replyContent: '喵呜，本喵查了一下但没查到相关信息，稍后再试试吧~',
            targetMessageId: message.messageId,
          }],
          toolsUsed: [],
          toolExecutionFailed: true,
        };
      }
    }
  }

  const messages = buildMessages(
    systemPrompt,
    contextStr,
    message,
    knowledge,
    checkinData,
    memberRoster,
    botKnowledge,
    userProfile,
    userPreferences,
    selfReflection,
    toolResultsBlock,
    exactReplyCount ? { exactReplyCount } : undefined,
    chatId,
    burstHint,
  );

  // 5. Call AI final writer (direct or planned both use no-tools final synthesis)
  let result: Awaited<ReturnType<typeof generateReplyModelOutput>>;
  try {
    result = await generateReplyModelOutput(messages, usage, { signal: interruptSignal });
    result.toolsUsed = toolsUsed;
  } catch (err) {
    // Handle content safety rejection gracefully
    if (err instanceof AIError && err.code === 'AI_CONTENT_REJECTED') {
      logger.warn({
        chatId,
        err: err.message,
        model: err.model,
        provider: err.provider,
        messageLength: message.textContent?.length ?? 0,
        contextLength: contextStr.length,
      }, 'Reply rejected by content safety filter');
      return {
        replies: [{
          replyContent: '唔……这个话题本喵不太方便聊呢',
          targetMessageId: message.messageId,
        }],
        toolsUsed: [],
        toolExecutionFailed: false,
      };
    }
    throw err;
  }

  // 6. Parse response (now returns array)
  let parsedReplies = parseReplyResponse(result.content, message.messageId);

  if (parsedReplies.some((reply) => containsToolArtifact(reply.replyContent))) {
    logger.warn({ chatId }, 'Tool artifact detected in final reply draft, regenerating');
    for (let i = 0; i < MAX_TOOL_ARTIFACT_RETRIES; i++) {
      result = await generateReplyModelOutput(appendToolArtifactRetryInstruction(messages), usage, {
        temperatureOverride: 0,
        signal: interruptSignal,
      });
      result.toolsUsed = toolsUsed;
      parsedReplies = parseReplyResponse(result.content, message.messageId);
      if (!parsedReplies.some((reply) => containsToolArtifact(reply.replyContent))) break;
    }
  }

  // 7. Duplicate detection — check first reply only (the main content)
  if (parsedReplies[0] && await isDuplicateReply(chatId, parsedReplies[0].replyContent)) {
    logger.info({ chatId }, 'Duplicate reply detected, regenerating');
    for (let i = 0; i < MAX_DUPLICATE_RETRIES; i++) {
      result = await generateReplyModelOutput(messages, usage, {
        temperatureOverride: 1.0,
        signal: interruptSignal,
      });
      result.toolsUsed = toolsUsed;
      parsedReplies = parseReplyResponse(result.content, message.messageId);
      if (!parsedReplies[0] || !(await isDuplicateReply(chatId, parsedReplies[0].replyContent))) break;
    }
  }

  // ── G2 action split: react/silent 抽离,sticker 标记为一等动作 ──
  let reactions: Array<{ targetMessageId: number; emoji: string }> | undefined;
  let modelSilent: boolean | undefined;
  if (callOpts?.actionSpace) {
    const reactItems = parsedReplies.filter((r) => r.action === 'react' && r.emoji);
    if (reactItems.length > 0) {
      // 每回合最多 1 个 react,避免刷屏
      reactions = reactItems.slice(0, 1).map((r) => ({
        targetMessageId: r.targetMessageId,
        emoji: r.emoji!,
      }));
    }
    const silentChosen = parsedReplies.some((r) => r.action === 'silent');
    parsedReplies = parsedReplies.filter(
      (r) => r.action === undefined || r.action === 'reply' || r.action === 'sticker',
    );
    for (const r of parsedReplies) {
      if (r.action === 'sticker') r.modelStickerAct = true;
    }
    // 主动沉默:模型明确选择不说话(react 仍可执行)
    modelSilent = parsedReplies.length === 0 && (silentChosen || !!reactions) ? true : undefined;
  } else {
    // 动作空间未启用:静默丢弃模型越权产生的动作元素
    parsedReplies = parsedReplies.filter((r) => r.action === undefined || r.action === 'reply');
    if (parsedReplies.length === 0) {
      parsedReplies = [{ replyContent: '…', targetMessageId: message.messageId }];
    }
  }

  const hasHandoff = parsedReplies.length === 1 && parsedReplies[0]!.handoffToSplitter === true;

  if (exactReplyCount && parsedReplies.length !== exactReplyCount && !hasHandoff) {
    logger.info({ chatId, exactReplyCount, actualReplyCount: parsedReplies.length }, 'Explicit multi-reply request not satisfied, regenerating');
    for (let i = 0; i < MAX_MULTI_REPLY_RETRIES; i++) {
      result = await generateReplyModelOutput(messages, usage, {
        temperatureOverride: 1.0,
        signal: interruptSignal,
      });
      result.toolsUsed = toolsUsed;
      parsedReplies = parseReplyResponse(result.content, message.messageId);
      if (parsedReplies.length === exactReplyCount) break;
    }
  }


  // 8. Code-based reply segmentation — MaiBot-style natural splitting
  // Only apply segmenter to single replies that are either:
  //   a) Long enough to warrant splitting (> threshold), or
  //   b) Explicitly handed off by the AI
  const needsSegment =
    parsedReplies.length === 1 &&
    (parsedReplies[0]!.replyContent.length > REPLY_SPLITTER_CHAR_THRESHOLD ||
      parsedReplies[0]!.handoffToSplitter === true);

  if (needsSegment) {
    const primaryTargetId = parsedReplies[0]!.targetMessageId;
    const { segments } = segmentReply(parsedReplies[0]!.replyContent, segmenterConfig);

    if (segments.length > 1) {
      parsedReplies = segments.map((seg, idx) => ({
        replyContent: seg,
        targetMessageId: primaryTargetId,
        // Only first segment gets quote-reply; the rest go without
        replyQuote: idx === 0 ? parsedReplies[0]!.replyQuote : false,
      }));
      logger.debug({ count: segments.length }, 'Code segmenter split reply into multiple messages');
    }
  }

  const latencyMs = Math.round(performance.now() - start);
  logger.info({
    chatId,
    action,
    replyPath: effectiveReplyPath,
    replyTier: effectiveReplyTier,
    model: result.model,
    tokens: result.tokenUsage.total,
    latencyMs,
    toolsUsed: result.toolsUsed,
    replyCount: parsedReplies.length,
    replyLength: parsedReplies.map(r => r.replyContent.length),
  }, `Reply generated (${parsedReplies.length} message(s))`);

  return {
    // 残余守卫:重试路径可能重新解析出动作元素,最终只放行文本/贴纸
    replies: parsedReplies.filter((p) => !p.action || p.action === 'reply' || p.action === 'sticker').map(p => ({
      replyContent: p.replyContent,
      targetMessageId: p.targetMessageId,
      stickerIntent: p.stickerIntent,
      replyQuote: p.replyQuote,
      modelStickerAct: p.modelStickerAct,
    })),
    toolsUsed: result.toolsUsed,
    toolExecutionFailed,
    reactions,
    modelSilent,
  };
}
