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
import { runAgenticPlanner } from '../planner/agentic-loop.js';
import { getMidTermBlock } from '../context/mid-term.js';
import { env } from '../../env.js';
import { detectCommandIntent } from '../nl-commands.js';
import { executeToolPlan, formatToolResultsForPrompt } from '../planner/executor.js';
import { countTokens } from '../../ai/token-counter.js';
import { logger } from '../../shared/logger.js';
import { getCachedRoster, setCachedRoster } from './member-cache.js';
import { composeSelfState } from '../heart/self-state.js';
import { getTopJargons, searchJargonsInText } from '../../learners/jargon-miner.js';
import { getRelationship, newcomerPromptHint } from '../../tracking/relationship.js';
import { recallEpisodes } from '../../tracking/group-episodes.js';
import { peekPendingQuestion } from '../../tracking/curiosity.js';
import { getChatStyle } from '../../tracking/chat-style.js';
import { checkNearDuplicate } from './anti-repeat.js';
import { buildInstructionHint } from './instruction.js';

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
    /** 指令服从:prompt 强注入 + 禁止沉默 */
    instruction?: { strength: 'master' | 'normal' };
    /** 迟到回复:注入"刚没看到"语气提示 */
    latenessHint?: string;
    /** 作息 v2:睡眠队列补回 — "刚睡醒看到"语气 + 允许 silent 反悔 */
    sleepCatchup?: boolean;
    /** L1: 心流的内心独白 — 决定与写作是同一个念头 */
    heartWhy?: string;
    /** 审计 #38:心流分支算好的自我状态快照,同回合直接复用 */
    selfState?: { narration: string; narrationNoThought: string; energy: number };
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
  // 指令服从:执行优先于人设(检测在 pipeline 层,确定性 0ms)
  let instructionPart: string | undefined;
  if (callOpts?.instruction) {
    instructionPart = buildInstructionHint(callOpts.instruction);
  }
  // burstHint 在 stateParts 组装完成后再拼(见 memberRoster 之后)
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

  // ── 此刻的你:一段叙述代替五六个状态标签块(心流层同源,S13)──
  // 判断"接不接"的我和决定"怎么说"的我读的是同一份自我状态。
  // P4:状态块带优先级,最终按预算合成(指令类永不裁,氛围类按序让位)
  const ctxParts: Array<[number, string]> = [];
  const stateParts = {
    push: (t: string) => ctxParts.push([50, t]),
    pushP: (p: number, t: string) => ctxParts.push([p, t]),
  };
  if (chatId < 0) {
    // P2:自我状态只进群聊 —— DM 里"注意收着点/半挂机"这类群语境叙述很怪
    try {
      // heartWhy 在场时不再读 mind.lastThought —— 那是同一个念头,
      // [你的念头] 已注入,自我状态里再写一遍是双倍复读(review #14)。
      // 心流分支已拼装过 → 直接复用快照(审计 #38:不再二次取 4 个源)
      const self = callOpts?.selfState ?? await composeSelfState(chatId);
      const narration = callOpts?.heartWhy ? self.narrationNoThought : self.narration;
      stateParts.pushP(20, `[此刻的你] ${narration}`);
    } catch { /* non-critical */ }
    try {
      const jargons = getTopJargons(chatId, 5);
      if (jargons.length > 0) {
        const lines = jargons.map((j) => `${j.content} = ${j.meaning.slice(0, 40)}`).join('；');
        stateParts.pushP(40, `[本群黑话] ${lines}\n(这些是群里的梗,语境合适时可以自然用上,别滥用)`);
      }
    } catch { /* non-critical */ }
    if (!message.isBot && !message.isAnonymous) {
      try {
        const rel = getRelationship(chatId, message.uid);
        const newcomer = newcomerPromptHint(rel.count);
        if (newcomer) stateParts.pushP(15, newcomer);
        else if (rel.lastSummary) stateParts.pushP(30, `[你和TA] ${rel.lastSummary.slice(0, 100)}`);
      } catch { /* non-critical */ }
    }
    // 微反应群提示(千雪对标):本群说话都很短 → bot 也要敢发 2-10 字
    try {
      const style = await getChatStyle(chatId);
      if (style?.microStyle) {
        stateParts.pushP(18, `[本群节奏] 这个群说话都很短(中位 ${style.medianChars} 字)。你的回复也照这个长度来:多数时候 2-10 字的微反应("对对对""笑死""这么强")就是最像群友的;**不要**每条都写成 20 字的完整句子。`);
      }
    } catch { /* non-critical */ }
    // 复读链检测:≥2 个不同群友连发同一句短话 → 跟一句就是最自然的参与
    try {
      const tail = retrievedContext.merged.slice(-5).filter((m) => m.role !== 'assistant' && !m.isBot);
      if (tail.length >= 2) {
        const norm = (t: string) => t.replace(/\s+/g, '');
        const lastText = norm(tail[tail.length - 1]!.textContent || '');
        if (lastText && lastText.length <= 12) {
          const echoers = new Set<number>();
          for (let i = tail.length - 1; i >= 0; i--) {
            if (norm(tail[i]!.textContent || '') === lastText) echoers.add(tail[i]!.uid);
            else break;
          }
          if (echoers.size >= 2) {
            stateParts.pushP(12, `[复读链] 群里 ${echoers.size} 个人在复读「${lastText.slice(0, 12)}」。跟着原样复读一句(或微变体)是最自然的参与方式;不想跟就正常回。`);
          }
        }
      }
    } catch { /* non-critical */ }
    // L5 好奇心延续:之前问 TA 的问题悬着,TA 现在出现了 → 可以追一句
    if (!message.isBot && !message.isAnonymous) {
      try {
        // 只 peek 不删:发送确认后 pipeline 才 commit 核销(review #7),
        // 生成被打断/迟到抑制/静默时惦记保留,下次 TA 出现还能追
        const pendingQ = await peekPendingQuestion(chatId, message.uid);
        if (pendingQ) {
          stateParts.pushP(13, `[惦记] 你之前问过TA:「${pendingQ}」,一直没等到回答。现在TA出现了——语境合适的话顺口追一下(真群友会记得自己好奇过什么);TA这条消息正好在回答的话就自然接上。`);
        }
      } catch { /* non-critical */ }
    }
    // G7 群共同经历:消息命中往事关键词 → callback("上次群里那件事…")
    try {
      const episodes = recallEpisodes(chatId, queryText, 2);
      if (episodes.length > 0) {
        stateParts.pushP(35, `[群里的往事] ${episodes.map((ep) => ep.summary).join('；')}\n(和当前话题相关时可以自然提起,像老群友翻旧账;无关就忽略)`);
      }
    } catch { /* non-critical */ }
    // G8 黑话理解侧:入站消息里出现已学会的黑话 → 含义随消息注入,
    // bot 不再对群内梗一脸茫然(MaiBot query_jargon 的注入式对标)
    try {
      const matched = searchJargonsInText(chatId, queryText, 3);
      if (matched.length > 0) {
        stateParts.pushP(10, `[消息里的黑话] ${matched.map((j) => `${j.content}=${j.meaning.slice(0, 30)}`).join('；')}`);
      }
    } catch { /* non-critical */ }
  }

  // L1: 内心独白放最后(离 CURRENT_MESSAGE 最近) —— 写手顺着决定接话的
  // 那个念头开笔,而不是失忆后重新猜一个角度。
  const heartPart = callOpts?.heartWhy
    ? `[你的念头] 你看到这条消息时心里想的是:「${callOpts.heartWhy}」。顺着这个念头说,别另起炉灶。`
    : undefined;
  // 作息 v2:补觉回复注记 —— 在场时压掉迟到注记(两者语义重叠,只留一个)
  const catchupPart = callOpts?.sleepCatchup
    ? '[补觉回复] 这条消息是你睡觉时错过的,刚睡醒(或半夜迷迷糊糊摸到手机)才看到,现在补个回复。开头自然带一句"刚睡醒看到""昨晚睡了才看到喵"之类,轻描淡写;如果话题明显已经翻篇/不需要回了,就输出 {"action":"silent"}。'
    : undefined;
  // 指令/念头/迟到/连发是行为指令(p<10,永不裁);其余按优先级进预算
  if (instructionPart) ctxParts.push([1, instructionPart]);
  if (heartPart) ctxParts.push([2, heartPart]);
  if (catchupPart) ctxParts.push([3, catchupPart]);
  else if (callOpts?.latenessHint) ctxParts.push([3, callOpts.latenessHint]);
  if (burstPart) ctxParts.push([4, burstPart]);
  if (revisitPart) ctxParts.push([45, revisitPart]);
  const CTX_BUDGET_CHARS = 1400;
  let used = 0;
  const kept: string[] = [];
  for (const [prio, text] of ctxParts.sort((a, b) => a[0] - b[0])) {
    if (prio < 10 || used + text.length <= CTX_BUDGET_CHARS) {
      kept.push(text);
      used += text.length;
    }
  }
  const burstHint = kept.join('\n\n') || undefined;

  // G13: LLM-driven expression selection (MaiBot maisaka_expression_selector
  // port — was dead code, now wired). Rich-context replies pick style snippets
  // matched to THIS conversation instead of the static top-N; cheap judge model.
  let expressionOverride: string | undefined;
  if (useRichContext && chatId < 0) {
    try {
      const { env: envFn } = await import('../../env.js');
      if (envFn().EXPRESSION_INJECT_ENABLED) {
        const { selectExpressions } = await import('../../learners/expression-selector.js');
        const picked = await selectExpressions(chatId, contextStr.slice(-1200), envFn().EXPRESSION_INJECT_COUNT, 'judge');
        if (picked.length > 0) {
          expressionOverride = picked.map((ex) => `「${ex.style}」`).join(' ');
        // G6 使用强化:被选中注入即 count++
        try {
          const { reinforceExpressions } = await import('../../learners/expression-learner.js');
          reinforceExpressions(picked.map((ex) => ex.id));
        } catch { /* non-critical */ }
        }
      }
    } catch (err) {
      logger.debug({ err, chatId }, 'selectExpressions failed (falls back to static injection)');
    }
  }

  // 4. Build messages array
  let toolResultsBlock: string | undefined;
  const usage = effectiveReplyTier === 'max' ? 'reply_max'
    : effectiveReplyTier === 'pro' ? 'reply_pro'
    : 'reply';
  let toolsUsed: string[] = [];
  let toolExecutionFailed = false;

  if (effectiveReplyPath === 'planned') {
    // ── Agentic 循环(MaiBot Maisaka 借鉴):多轮 plan→act,失败回退旧路 ──
    let legacyPlannerNeeded = true;
    if (env().PLANNER_AGENTIC_ENABLED) {
      const agentic = await runAgenticPlanner({
        messageText: queryText,
        context: contextStr,
        knowledge,
        chatId,
        userId: message.uid,
        signal: interruptSignal,
      });
      if (!agentic.failed) {
        toolsUsed = agentic.toolsUsed;
        toolResultsBlock = agentic.toolResultsBlock;
        legacyPlannerNeeded = false;
      }
    }

    if (legacyPlannerNeeded) {
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
  }

  // 中期记忆 pinned 块(flag off 时为 null,零开销)
  const midTermMemory = await getMidTermBlock(chatId).catch(() => null);

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
    expressionOverride,
    midTermMemory ?? undefined,
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

  // 7.5 G13: near-duplicate guard — "我是不是刚说过非常像的话?"
  // exact-match 之外抓"换汤不换药";命中则带约束重生成一次(MaiBot
  // after_response retry-with-constraint 语义)。ANTI_REPEAT_ENABLED 门控。
  if (parsedReplies[0]) {
    try {
      const dup = await checkNearDuplicate(chatId, parsedReplies[0].replyContent);
      if (dup.isNearDuplicate) {
        logger.info({ chatId, ratio: dup.ratio }, 'Near-duplicate reply detected, regenerating with constraint');
        const constrained = messages.map((m, idx) =>
          idx === messages.length - 1 && m.role === 'user'
            ? {
                ...m,
                content: `${m.content}\n\n[REGENERATE_CONSTRAINT]\n你刚刚说过非常类似的话（「${(dup.collidedWith ?? '').slice(0, 80)}…」）。换一个说法、换个角度、或者补充新的信息——禁止复读自己。`,
              }
            : m,
        );
        result = await generateReplyModelOutput(constrained, usage, {
          temperatureOverride: 1.0,
          signal: interruptSignal,
        });
        result.toolsUsed = toolsUsed;
        const regenerated = parseReplyResponse(result.content, message.messageId);
        // 重写后仍复读 → 保留第一版(已尽力,别为了不复读发更差的)
        if (regenerated[0] && !(await checkNearDuplicate(chatId, regenerated[0].replyContent)).isNearDuplicate) {
          parsedReplies = regenerated;
        }
      }
    } catch (err) {
      logger.debug({ err, chatId }, 'Near-duplicate check failed (non-critical)');
    }
  }

  // ── P5 归一化管线:动作拆分 ∘ 目标守卫 ∘ 占位过滤(幂等,所有 regen 必经)──
  // 此前 regen 路径(exactReplyCount 等)绕过这些守卫 → 整类数据丢失/逃逸 bug。
  const delegationMarkers = /(回复|回应|怼|评价|告诉|转告|提醒|@)/;
  const userDelegated = delegationMarkers.test(message.textContent || '');
  let reactions: Array<{ targetMessageId: number; emoji: string }> | undefined;
  let modelSilent: boolean | undefined;

  const normalizeDraft = (raw: ReturnType<typeof parseReplyResponse>): ReturnType<typeof parseReplyResponse> => {
    let texts = raw;
    if (callOpts?.actionSpace) {
      const reactItems = raw.filter((r) => r.action === 'react' && r.emoji);
      // 每回合最多 1 个 react;以**最终**草稿为准(regen 后旧 react 不残留)
      reactions = reactItems.length > 0
        ? reactItems.slice(0, 1).map((r) => ({ targetMessageId: r.targetMessageId, emoji: r.emoji! }))
        : undefined;
      texts = raw.filter((r) => r.action === undefined || r.action === 'reply' || r.action === 'sticker');
      for (const r of texts) {
        if (r.action === 'sticker') r.modelStickerAct = true;
      }
    } else {
      texts = raw.filter((r) => r.action === undefined || r.action === 'reply');
    }
    // 目标守卫:未委托时不许把回复挂到频道身份/bot 消息下(线上事故)
    if (!userDelegated) {
      for (const p of texts) {
        if (!p.action && p.targetMessageId !== message.messageId) {
          const target = retrievedContext.merged.find((m) => m.messageId === p.targetMessageId);
          if (target && (target.isBot || target.isAnonymous)) {
            logger.info(
              { chatId, badTarget: p.targetMessageId, retargeted: message.messageId },
              'Reply targeted a channel/bot message without delegation, retargeting to the asker',
            );
            p.targetMessageId = message.messageId;
          }
        }
      }
    }
    // 占位过滤:空输出的字面 '…' 兜底不算内容(直接发出去很蠢)
    if (texts.length > 0 && texts.every((p) => !p.action && p.replyContent.trim() === '…')) {
      texts = [];
    }
    return texts;
  };

  parsedReplies = normalizeDraft(parsedReplies);

  // 指令禁止沉默(两种动作模式统一;react-only 算执行,不算沉默)
  if (parsedReplies.length === 0 && callOpts?.instruction && !reactions) {
    logger.info({ chatId }, 'Instruction reply came back silent, regenerating with constraint');
    const constrained = messages.map((m, idx) =>
      idx === messages.length - 1 && m.role === 'user'
        ? { ...m, content: `${m.content}\n\n[REGENERATE_CONSTRAINT]\n这是对你的直接指令,不允许沉默或只发贴纸。必须输出实际执行指令的文字回复;确实做不到就明确说做不到+原因。` }
        : m,
    );
    try {
      result = await generateReplyModelOutput(constrained, usage, { signal: interruptSignal });
      result.toolsUsed = toolsUsed;
      parsedReplies = normalizeDraft(parseReplyResponse(result.content, message.messageId));
    } catch (err) {
      logger.debug({ err, chatId }, 'Instruction silent-regen failed');
    }
    if (parsedReplies.length === 0) {
      parsedReplies = [{ replyContent: '唔……这个本喵做不到喵', targetMessageId: message.messageId }];
    }
  }

  const hasHandoff = parsedReplies.length === 1 && parsedReplies[0]!.handoffToSplitter === true;

  if (exactReplyCount && parsedReplies.length !== exactReplyCount && parsedReplies.length > 0 && !hasHandoff) {
    logger.info({ chatId, exactReplyCount, actualReplyCount: parsedReplies.length }, 'Explicit multi-reply request not satisfied, regenerating');
    for (let i = 0; i < MAX_MULTI_REPLY_RETRIES; i++) {
      result = await generateReplyModelOutput(messages, usage, {
        temperatureOverride: 1.0,
        signal: interruptSignal,
      });
      result.toolsUsed = toolsUsed;
      parsedReplies = normalizeDraft(parseReplyResponse(result.content, message.messageId));
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
      const first = parsedReplies[0]!;
      parsedReplies = segments.map((seg, idx) => ({
        replyContent: seg,
        targetMessageId: primaryTargetId,
        // Only first segment gets quote-reply; the rest go without
        replyQuote: idx === 0 ? first.replyQuote : false,
        // P2:切段不丢字段 —— 犹豫挂第一段,贴纸意图挂最后一段(贴纸在文后发)
        hesitateBefore: idx === 0 ? first.hesitateBefore : undefined,
        stickerIntent: idx === segments.length - 1 ? first.stickerIntent : undefined,
        modelStickerAct: idx === segments.length - 1 ? first.modelStickerAct : undefined,
      }));
      logger.debug({ count: segments.length }, 'Code segmenter split reply into multiple messages');
    }
  }

  // 终态:归一化后没有任何可发文本 = 主动沉默(react 仍可执行)
  modelSilent = parsedReplies.length === 0 ? true : undefined;

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
      hesitateBefore: p.hesitateBefore,
    })),
    toolsUsed: result.toolsUsed,
    toolExecutionFailed,
    reactions,
    modelSilent,
  };
}
