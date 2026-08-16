// ────────────────────────────────────────
// Reply Orchestrator — generate reply via AI
// ────────────────────────────────────────

import { resolveReplyPath } from '../../shared/types.js';
import { isDM } from '../../shared/chat.js';
import type { FormattedMessage, RetrievedContext, ReplyOutput, ReplyPath } from '../../shared/types.js';
import type { JudgeAction } from '../../shared/types.js';
import { callWithFallback } from '../../ai/fallback.js';
import { incrCounter } from '../../metrics/registry.js';
import type { ContentPart } from '../../ai/types.js';
import { AIError } from '../../shared/errors.js';
import { buildSystemPrompt, buildMessages } from './prompt-builder.js';
import { modelStyleNudge } from './model-style.js';
import { getUsage, getLabel } from '../../ai/labels.js';
import { slimContextForAI } from '../context/slim.js';
import { searchKnowledge } from '../../knowledge/manager.js';
import { getToolNames } from '../tools/registry.js';
import { parseReplyResponse, isBlankReply } from './parser.js';
import { segmentReply, type SegmenterConfig, REPLY_SPLIT_CHAR_THRESHOLD } from './segmenter.js';
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
import { getTopJargonsForContext, searchJargonsInText } from '../../learners/jargon-miner.js';
import { getRelationship, newcomerPromptHint } from '../../tracking/relationship.js';
import { recallEpisodes, type GroupEpisode } from '../../tracking/group-episodes.js';
import { peekPendingQuestion } from '../../tracking/curiosity.js';
import { getChatStyle } from '../../tracking/chat-style.js';
import { checkNearDuplicate } from './anti-repeat.js';
import { buildInstructionHint } from './instruction.js';
import { assembleBurstHint, type CtxPart } from './burst-hint.js';

const MAX_DUPLICATE_RETRIES = 1;
const MAX_MULTI_REPLY_RETRIES = 1;
const MAX_TOOL_ARTIFACT_RETRIES = 1;
// Context token budget for the reply model. Was tiered (normal/pro/max = 48k/72k/100k);
// tier system removed — single budget, former 'pro' value as the balance point.
const REPLY_CONTEXT_BUDGET = 72_000;

const MAX_EMPTY_RETRIES = 1; // 1 retry:大多空响应一次即恢复;避免和下游 6 个 regen 分支叠乘放大调用数
const stripThinking = (s: string): string => s.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

// P2 多模态直读:带图回复时最后一条 user 消息是 ContentPart[](图+文),
// 各 regen/retry 分支不能再直接字符串拼接 content。
type ReplyMessage = { role: 'system' | 'user' | 'assistant'; content: string | ContentPart[] };

function appendReplyText(m: ReplyMessage, suffix: string): ReplyMessage {
  if (typeof m.content === 'string') return { ...m, content: m.content + suffix };
  return { ...m, content: [...m.content, { type: 'text' as const, text: suffix }] };
}

async function generateReplyModelOutput(
  messages: ReplyMessage[],
  usage: string,
  opts?: { temperatureOverride?: number; signal?: AbortSignal },
) {
  const jsonMode = env().REPLY_JSON_MODE;
  let result = await callWithFallback({
    usage,
    messages,
    temperature: opts?.temperatureOverride,
    signal: opts?.signal,
    jsonMode,
  });
  let content = stripThinking(result.content);

  // DeepSeek V4 Flash 偶发返回空 content(~1/5,官方文档承认需客户端兜)。空响应不报错 →
  // 以前那一轮回复被默默吞成静默。这里带约束重试(略升温打破确定性空输出),
  // 把空回复率从 ~21% 压到个位数。
  for (let attempt = 0; attempt < MAX_EMPTY_RETRIES && !content && !opts?.signal?.aborted; attempt++) {
    logger.warn({ usage, attempt }, 'Empty model output, retrying with constraint');
    const constrained = messages.map((m, idx) =>
      idx === messages.length - 1 && m.role === 'user'
        ? appendReplyText(m, '\n\n[RETRY] 上次输出为空。你必须输出合法的 reply JSON(replyContent 非空),不允许空响应。')
        : m,
    );
    result = await callWithFallback({
      usage,
      messages: constrained,
      // 略升温打破确定性空输出;Math.max 保证即便 caller 传了 temperatureOverride:0 也会升到 0.5
      temperature: Math.max(opts?.temperatureOverride ?? 0, 0.5),
      signal: opts?.signal,
      jsonMode,
    });
    content = stripThinking(result.content);
  }

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
  messages: ReplyMessage[],
): ReplyMessage[] {
  return messages.map((message, index) => {
    if (index !== messages.length - 1 || message.role !== 'user') return message;
    return appendReplyText(
      message,
      '\n\n[RETRY_INSTRUCTION]\n上一次输出泄露了工具原始结果。必须把 [TOOL_RESULTS] 综合成自然语言回复，并严格输出 reply JSON；禁止原样复制 <web_search>、Search results、Title/URL 列表或 [TOOL_RESULTS] 标记。',
    );
  });
}

function detectExactReplyCountRequest(message: FormattedMessage): number | undefined {
  const text = (message.textContent || message.captionContent || '').trim();
  if (!text) return undefined;

  if (/(发我两条|发两条|两条消息|两句|一人一条|分别回|各发一条)/i.test(text)) {
    return 2;
  }

  // "帮我回X" / "回复X" / "去怼X" / "告诉X" — 需要先回指令者、再回目标
  if (/(帮我回|帮我怼|帮我告诉|去回他|去回复|回复.{0,6}给他|回一下.{0,6}跟他|转告|帮我@)/i.test(text)) {
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
 * P2-F:[等待结束] 回访提示 —— MaiBot 在 wait 到点时往共享历史注入
 * "wait 已完成(有/无新消息)"标记的写手侧等价物。纯函数可单测。
 */
export function buildWaitResumeHint(w: { waitSec?: number; hadNewMessages: boolean }): string {
  const dur = w.waitSec ? `${w.waitSec} 秒` : '一会儿';
  return w.hadNewMessages
    ? `[等待结束] 你刚才决定先等${dur}再说,现在等完了,期间群里有新消息(都在上方上下文里)。结合新信息回应,别当没等过。`
    : `[等待结束] 你刚才决定先等${dur}再说,现在等完了,期间**没有**新消息——TA没接着说。把你想说的说完,或自然接回刚才的话头;确实没必要说就输出 {"action":"silent"}。`;
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
  segmenterConfig?: Partial<SegmenterConfig>,
  callOpts?: {
    signal?: AbortSignal;
    burstIds?: number[];
    /** 本回合是多锚点分人回合(actor 已把不同人拆成各自独立的回复调用)。
     *  为 true 时:这一条只回 CURRENT_MESSAGE 那个人,别替上下文里别人回话/张冠李戴。 */
    isMultiAnchor?: boolean;
    revisitCandidates?: Array<{ messageId: number; sender: string; snippet: string }>;
    /** G2: 统一动作空间已启用 — 解析并执行 react/sticker/silent 动作 */
    actionSpace?: boolean;
    /** 指令服从:prompt 强注入 + 禁止沉默 */
    instruction?: { strength: 'master' | 'normal' };
    /** 迟到回复:注入"刚没看到"语气提示 */
    latenessHint?: string;
    /** 作息 v2:睡眠队列补回 — "刚睡醒看到"语气 + 允许 silent 反悔 */
    sleepCatchup?: boolean;
    /** P2-F:wait 回访 — "你刚等了 N 秒,期间有/无新消息"提示 */
    waitResume?: { waitSec?: number; hadNewMessages: boolean };
    /** 本条消息是否"寻址"了 bot(@提及 / 回复 bot / L0 direct 规则命中)。
     *  自然语言命令意图(签到等**带副作用**的)只在为 true 时才生效 —— 见下面 3.5 的注释。 */
    isAddressed?: boolean;
    /** L1: 心流的内心独白 — 决定与写作是同一个念头 */
    heartWhy?: string;
    /** 审计 #38:心流分支算好的自我状态快照,同回合直接复用 */
    selfState?: { narration: string; narrationNoThought: string; energy: number };
    /** Multi-Agent:编排器已并行跑完专家(研究员等)gather 的结果块。提供时
     *  跳过内部 planner/merged-tools(避免重复跑工具),直接当 toolResults 注入。 */
    prebuiltToolResults?: string;
    /** Multi-Agent:编排器已做过"要不要工具"的决策(研究员跑过,无论是否用到
     *  工具)。true 时跳过内部 planner/merged-tools(纯文本写手),避免研究员
     *  说"不需要工具"后写手又重新决策一遍(double LLM)。仅在研究员 failed
     *  时留 false,让写手回退到自己的工具决策兜底。 */
    toolDecisionHandled?: boolean;
    /** Multi-Agent 记忆员产出(独立通道)。拼到 knowledge 里随 [知识库] 注入,
     *  不抢占研究员的 toolResults 槽 —— 这样 researcher 失败时写手仍能走 web
     *  兜底,同时带着记忆员的召回。 */
    memoryFindings?: string;
    /** Multi-Agent 导演专家产出:[导演定调] 情绪/姿态/切入点块,紧贴念头注入。 */
    directorHint?: string;
    /** Multi-Agent 上下文理解专家产出:[现在在聊] digest 块,帮写手抓重点。 */
    contextDigest?: string;
    /** Multi-Agent 预取的群往事(best-of-N 时复用,避免 recallEpisodes 的
     *  recall_count 被多稿各调一次而 ×N 失真)。提供时跳过内部 recallEpisodes。 */
    prefetchedEpisodes?: GroupEpisode[];
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
  // 多锚点分人回合:actor 已把不同人拆成各自独立的调用,这次的 burstIds 只剩
  // 「CURRENT 这个人」自己的连发 → 不能再走"多个不同人分数组"分支(那会让它又去
  // 替上下文里别的人回话 = 张冠李戴)。收窄成"这一个人的连发当一个念头回一条"。
  const burstPart = callOpts?.burstIds && callOpts.burstIds.length > 1
    ? (callOpts.isMultiAnchor
        // 多锚点分人回合:actor 已按人拆开,这一条围绕 CURRENT 那个人回(不断言"全是
        // 同一人"——replan 后 burstIds 可能混入别人;以 CURRENT_MESSAGE 为准)。保留
        // "同一人发多个独立问题可分条"的能力,只是不去接别人的话题(见 [只回这一个人])。
        ? `[连发上下文] 这波（${callOpts.burstIds.map((id) => `#${id}`).join('、')}）围绕 [CURRENT_MESSAGE_TO_REPLY] 这个人:一个念头分几条发 → 回一条（targetMessageId 选承载重点那条，往往是提问那条、不一定是最后一条）；TA 问了几个**互相独立**的问题 → 可分几条各回、各填 TA 对应消息的 id。别把上下文里**别人**的话题接进来。`
        : `[连发上下文] 这次回复由一波连发触发，共 ${callOpts.burstIds.length} 条：${callOpts.burstIds.map((id) => `#${id}`).join('、')}（按时间顺序，最后一条最新，内容都在上方上下文里）。请把整波连发当作一个完整的念头来回应，不要只回最后一句。回复目标怎么选：\n- 整波是同一个念头分几条发 → 输出 1 条，targetMessageId 选真正承载重点的那条（往往是提问/求助的那条，不一定是最后一条）。\n- 这波里有**两个以上互相独立的问题/请求**（同一个人连发的也算）→ 输出数组、每个问题各出一条，各自 targetMessageId 填对应那条的 id，分别回复——别把两个不相干的问题挤进一条、也别只挑一个回。`)
    : undefined;
  // 多锚点硬护栏:不管这个人是不是连发,只要本回合是"分人各回",都提醒写手这条
  // 只对 CURRENT 这一个人,别把上下文里别人的话题揉进来 / 别张冠李戴。
  const multiAnchorPart = callOpts?.isMultiAnchor
    ? `[只回这一个人] 本轮群里好几个人各自说了不同的事，系统已经把他们拆开、分别回复。你这次**只**回 [CURRENT_MESSAGE_TO_REPLY] 那个人（TA 自己若发了几条独立问题可以分开回）。群聊上下文里**其他人**的发言只是背景——别在这里替他们回话、别接他们抛的话题、别把别人说的话当成 TA 说的。其他人各有自己的回复，不用你一起管。`
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

  // 1. Build system prompt (5-layer)
  const systemPrompt = buildSystemPrompt(message.uid, chatId);

  // 2. Compress and format context — 复用 retriever 已算好的 slim 串与 token 数,
  //    避免对同一份 merged 再 slim+tiktoken 一遍(同步编码阻塞 event loop)。
  const contextStr = retrievedContext.contextStr ?? slimContextForAI(retrievedContext.merged, message, botUid);
  const budget = REPLY_CONTEXT_BUDGET;
  // Fast path: for CJK-heavy content, use ~2 chars/token heuristic to skip the
  // tokenizer when clearly over budget; reuse retriever's exact count when present.
  const contextTokens = retrievedContext.contextStr !== undefined
    ? retrievedContext.tokenCount
    : contextStr.length > budget * 2 ? budget : countTokens(contextStr);
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

  // Multi-Agent 记忆员产出(独立通道):拼到 knowledge 里随 [知识库] 注入,
  // 不占研究员的 web 工具决策槽 —— researcher 失败时写手仍可走 web 兜底,
  // 同时带着记忆员的召回。
  if (callOpts?.memoryFindings) {
    knowledge = (knowledge ? knowledge + '\n\n' : '') + callOpts.memoryFindings;
  }

  // 3.5 Checkin data injection — minimal real data, AI creates the rest
  // 频道/匿名身份不能签到（uid 是群/频道 ID，不是真实用户）
  let checkinData: string | undefined;
  const msgText = message.textContent || '';
  // Detect checkin/stats via exact slash command OR natural-language phrasing
  // (e.g. "帮我签到"), so the data is injected even when the bot wasn't formally
  // @addressed — otherwise the reply LLM hallucinates a checkin without the streak.
  // 自然语言意图**只在被寻址时**才算。intercepts.ts 的 NL 命令路由有寻址门
  // (addressed = isDM || ADDRESSED_RULES.has(rule)),而这里是第二次、独立的
  // detectCommandIntent 调用,原先除了 isAnonymous 之外没有任何门 —— 于是群里一句
  // 没有 @bot 的「今天忘了打卡」也会真的执行签到副作用。精确斜杠命令不受此限制。
  const addressedForCommands = isDM(chatId) || callOpts?.isAddressed === true;
  const cmdIntent = addressedForCommands ? detectCommandIntent(msgText) : null;
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

  // Was: planned path OR pro/max tier → rich context. Tier removed; planned-only
  // would silently drop member roster/persona for direct chat — keep rich for all.
  const useRichContext = true;
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
      // AGI L5 L6: 记忆陈旧注记 —— 该用户有 stale 旧资料时提示可能过时。
      if (userProfile && env().MEMORY_FRESHNESS_ENABLED) {
        const { staleCaveat } = await import('../../agent/memory-freshness.js');
        const caveat = staleCaveat(message.uid, chatId);
        if (caveat) userProfile += `\n${caveat}`;
      }
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
  // 顺序重排(三家评审共识):每块带两个独立的键 ——
  //   order = 在 burstHint 里的文本位置(升序=越靠前=离 CURRENT_MESSAGE 越远);
  //   keep  = 预算裁剪时的重要度(升序=越先保;<10 必留,永不被裁)。
  // 旧设计一个 priority 同时管"位置"和"重要度",导致"念头(最重要)"被
  // 排到块最前(离当前消息最远)——正好和"顺着念头开笔"的意图相反。
  // 拆开后:重要度照旧裁剪,文本顺序按 recency 重排(念头压轴、贴 CURRENT_MESSAGE)。
  const ctxParts: CtxPart[] = [];
  const stateParts = {
    push: (t: string) => ctxParts.push({ order: 50, keep: 50, text: t }),
    pushP: (order: number, keep: number, t: string) => ctxParts.push({ order, keep, text: t }),
  };
  if (chatId < 0) {
    // P2:自我状态只进群聊 —— DM 里"注意收着点/半挂机"这类群语境叙述很怪
    // 顺序:此刻的你(含回复规律)放靠后(order=50),贴近写作点;念头(order=99)压轴。
    try {
      // heartWhy 在场时不再读 mind.lastThought —— 那是同一个念头,
      // [你的念头] 已注入,自我状态里再写一遍是双倍复读(review #14)。
      // 心流分支已拼装过 → 直接复用快照(审计 #38:不再二次取 4 个源)
      const self = callOpts?.selfState ?? await composeSelfState(chatId);
      const narration = callOpts?.heartWhy ? self.narrationNoThought : self.narration;
      // P1:自我反思(长期回复规律)并入「此刻的你」——两者都是"当下的我"的
      // 底色,语义重叠;合并后不再在静态块顶端单列一块离 CURRENT_MESSAGE 老远。
      let selfBlock = `[此刻的你] ${narration}`;
      if (selfReflection) selfBlock += `\n(你最近的回复规律:${selfReflection.slice(0, 160)})`;
      stateParts.pushP(50, 20, selfBlock);
    } catch { /* non-critical */ }
    try {
      // 黑话合并(三家共识):消息里命中的黑话(理解侧,置顶看懂)+ 语境高频黑话
      // (表达侧,B 选择性注入,infra 话题先注 infra 域)→ 单块去重,不再分两块重复。
      const matched = searchJargonsInText(chatId, queryText, 3);
      const top = getTopJargonsForContext(chatId, queryText, 5);
      const seen = new Set<string>();
      const merged: Array<{ content: string; meaning: string }> = [];
      for (const j of [...matched, ...top]) {
        if (seen.has(j.content)) continue;
        seen.add(j.content);
        merged.push({ content: j.content, meaning: j.meaning });
        if (merged.length >= 6) break;
      }
      if (merged.length > 0) {
        const lines = merged.map((j) => `${j.content} = ${j.meaning.slice(0, 40)}`).join('；');
        stateParts.pushP(14, 10, `[本群黑话] ${lines}\n(群里的梗/行话:消息里出现的看懂它,语境合适时也能自然用上,别滥用)`);
      }
    } catch { /* non-critical */ }
    if (!message.isBot && !message.isAnonymous) {
      try {
        const rel = getRelationship(chatId, message.uid);
        const newcomer = newcomerPromptHint(rel.count);
        if (newcomer) stateParts.pushP(22, 15, newcomer);
        else if (rel.lastSummary) stateParts.pushP(32, 30, `[你和TA] ${rel.lastSummary.slice(0, 100)}`);
      } catch { /* non-critical */ }
    }
    // Per-model 风格补丁:按**实际用的 reply 模型**补一段专属提示(grok 天生利落无补丁,
    // gemini 爱啰嗦→压极简)。keep=2 必留、order=77 紧贴 CURRENT。用主 label 的 model
    // (fallback 到 backup 的少数情况仍用主模型的补丁,可接受)。
    try {
      const nudge = modelStyleNudge(getLabel(getUsage('reply').label).model);
      if (nudge) stateParts.pushP(77, 2, nudge);
    } catch { /* non-critical:label 解析失败就不补 */ }
    // 微反应群提示(千雪对标):本群说话都很短 → bot 也要敢发 2-10 字
    try {
      const style = await getChatStyle(chatId);
      if (style?.microStyle) {
        stateParts.pushP(18, 18, `[本群节奏] 这个群说话都很短(中位 ${style.medianChars} 字)。你的回复也照这个长度来:多数时候 2-10 字的微反应("对对对""笑死""这么强")就是最像群友的;**不要**每条都写成 20 字的完整句子。`);
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
            stateParts.pushP(10, 12, `[复读链] 群里 ${echoers.size} 个人在复读「${lastText.slice(0, 12)}」。跟着原样复读一句(或微变体)是最自然的参与方式;不想跟就正常回。`);
          }
        }
      }
    } catch { /* non-critical */ }
    // 口头禅惩罚:动态黑名单里的短语是你最近说腻了的口头禅,这条明确提醒别再用
    try {
      if (chatId < 0 && env().TIC_PENALTY_ENABLED) {
        const { getDynamicTicBans } = await import('../../learners/tic-detector.js');
        const bans = await getDynamicTicBans(chatId);
        if (bans.length > 0) {
          stateParts.pushP(6, 14, `[少说口头禅] 你最近老把「${bans.slice(0, 6).join('」「')}」挂嘴边,已经腻了。这几条这次**换个说法或直接不用**,别再复读。`);
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
          stateParts.pushP(34, 13, `[惦记] 你之前问过TA:「${pendingQ}」,一直没等到回答。现在TA出现了——语境合适的话顺口追一下(真群友会记得自己好奇过什么);TA这条消息正好在回答的话就自然接上。`);
        }
      } catch { /* non-critical */ }
    }
    // G7 群共同经历:消息命中往事关键词 → callback("上次群里那件事…")
    // best-of-N 时编排器预取 episodes 复用,避免多稿各调 recallEpisodes 使
    // recall_count ×N 失真(callOpts.prefetchedEpisodes 在场则跳过内部调用)。
    try {
      const episodes = callOpts?.prefetchedEpisodes ?? recallEpisodes(chatId, queryText, 2);
      if (episodes.length > 0) {
        stateParts.pushP(30, 35, `[群里的往事] ${episodes.map((ep) => ep.summary).join('；')}\n(和当前话题相关时可以自然提起,像老群友翻旧账;无关就忽略)`);
      }
    } catch { /* non-critical */ }
    // A 深度反思:注入"本群近况"——bot 像老群友一样了解群里最近的状态。
    if (env().REFLECTION_ENABLED) {
      try {
        const { getChatReflection } = await import('../../cron/deep-reflection.js');
        const digest = getChatReflection(chatId);
        if (digest) stateParts.pushP(28, 30, `[本群近况] ${digest}`);
      } catch { /* non-critical */ }
    }
  }

  // L1: 内心独白压轴(order=99,离 CURRENT_MESSAGE 最近) —— 写手顺着决定
  // 接话的那个念头开笔,而不是失忆后重新猜一个角度。keep=2(必留,永不被裁)。
  // (旧 bug:念头用 priority 2 入列被排到块最前,正好和这条意图相反。)
  const heartPart = callOpts?.heartWhy
    ? `[你的念头] 你看到这条消息时心里想的是:「${callOpts.heartWhy}」。顺着这个念头说,别另起炉灶。`
    : undefined;
  // AGI L5 L4: ToM 心智状态 —— 回复前先想 3 行:对方想要什么/什么情绪/期待什么反应。
  // 白捡的收益:让回复更有针对性,而不是答录机。(群聊 + flag 开启)
  const tomPart = env().TOM_STATE_ENABLED && chatId !== undefined && chatId < 0
    ? '[对方此刻的心智] 动笔前先在脑内过一遍:他这句话想要什么?他现在什么情绪?他期待我什么反应?想完直接写正文,不要把这 3 行输出出来。'
    : undefined;
  // 作息 v2:补觉回复注记 —— 在场时压掉迟到注记(两者语义重叠,只留一个)
  const catchupPart = callOpts?.sleepCatchup
    ? '[补觉回复] 这条消息是你睡觉时错过的,刚睡醒(或半夜迷迷糊糊摸到手机)才看到,现在补个回复。开头自然带一句"刚睡醒看到""昨晚睡了才看到喵"之类,轻描淡写;如果话题明显已经翻篇/不需要回了,就输出 {"action":"silent"}。'
    : undefined;
  // P2-F:wait 回访提示 —— MaiBot wait-completed 标记的写手侧等价物
  const waitPart = callOpts?.waitResume
    ? buildWaitResumeHint(callOpts.waitResume)
    : undefined;
  // 行为指令(指令/念头/补觉/连发):keep<10 必留;文本位置(order)按 recency
  // 排在氛围块之后、紧贴 CURRENT_MESSAGE —— 越是"怎么写这条"的指令越贴近消息。
  if (instructionPart) stateParts.pushP(80, 1, instructionPart);
  if (heartPart) stateParts.pushP(99, 2, heartPart);
  // AGI L5 L4: ToM 心智引导 —— 优先级 98 贴近念头,但不压过它。
  if (tomPart) stateParts.pushP(98, 2, tomPart);
  // Multi-Agent 导演/上下文理解专家产出:keep 调到 6/10 —— 是"建议"非硬约束,
  // 预算紧时让位于念头/指令/对话上下文,别挤掉真正必要的块(M7)。
  if (callOpts?.directorHint) stateParts.pushP(98, 6, callOpts.directorHint);
  if (callOpts?.contextDigest) stateParts.pushP(35, 10, callOpts.contextDigest);
  if (catchupPart) stateParts.pushP(72, 3, catchupPart);
  else if (callOpts?.latenessHint) stateParts.pushP(72, 3, callOpts.latenessHint);
  // P2-F:order=71 落在连发(70)与迟到/补觉(72)之间;keep=4 与连发同级可裁。
  if (waitPart) stateParts.pushP(71, 4, waitPart);
  if (burstPart) stateParts.pushP(70, 4, burstPart);
  // 分人护栏:keep=1 必留、order=79 紧贴 CURRENT(比指令 order=80 稍前),防被预算裁掉
  if (multiAnchorPart) stateParts.pushP(79, 1, multiAnchorPart);
  if (revisitPart) stateParts.pushP(40, 45, revisitPart);
  // 两遍合成(burst-hint.ts):① 按 keep 升序做预算裁剪(keep<10 必留);
  // ② 保留下来的再按 order 升序渲染。重要度与位置解耦 —— 念头最重要(keep=2)
  // 且最靠近 CURRENT_MESSAGE(order=99)不再矛盾。
  const CTX_BUDGET_CHARS = 1400;
  const burstHint = assembleBurstHint(ctxParts, CTX_BUDGET_CHARS);

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
  // Multi-Agent:编排器预跑的专家结果优先;有则跳过内部 planner/merged-tools。
  let toolResultsBlock: string | undefined = callOpts?.prebuiltToolResults;
  // 编排器已做工具决策(研究员跑过)→ 写手纯文本,不再自己调工具/重新决策。
  const orchestratorHandled = callOpts?.toolDecisionHandled === true;
  const usage = 'reply';
  let toolsUsed: string[] = [];
  let toolExecutionFailed = false;

  // 合并写手:planned 路径用"一次带工具的写手调用"替代"planner 轮+写手"两段。
  // 启用时跳过下面的预跑工具块(工具由写手自己边写边调),toolResultsBlock 留空。
  // prebuiltToolResults 在场 / orchestratorHandled 时禁用 merged(编排器已收口)。
  // P3:direct 路径也可挂工具(REPLY_DIRECT_TOOLS_ENABLED,默认关)——只给只读子集,
  // 让普通闲聊能查实时信息/回忆,又不给闲聊写手建投票/定时器/指挥别的 bot 的副作用口子。
  const directToolsActive = effectiveReplyPath === 'direct' && env().REPLY_DIRECT_TOOLS_ENABLED;
  const mergedToolsActive =
    env().REPLY_MERGED_TOOLS_ENABLED &&
    !toolResultsBlock &&
    !orchestratorHandled &&
    (effectiveReplyPath === 'planned' || directToolsActive);
  // direct 路径的只读工具白名单(副作用工具一律不给)
  const DIRECT_TOOL_SUBSET = [
    'SEARCH', 'FETCH', 'RECALL', 'QUERY_MEMORY', 'QUERY_PERSON_PROFILE',
    'FETCH_HISTORY', 'BOT_KNOWLEDGE', 'QUERY_JARGON',
  ];

  if (effectiveReplyPath === 'planned' && !mergedToolsActive && !toolResultsBlock && !orchestratorHandled) {
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

  const messages: ReplyMessage[] = buildMessages(
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

  // P2 多模态直读(默认关):触发消息带图(或回复的是图)时,把原图直接喂给回复
  // 模型 —— 通用文本描述是"概述",丢细节;直读让模型自己看图回答"多少钱/哪个好/
  // 图上写了啥"。带图后 fallback 链自动跳过声明 VISION=false 的纯文本 label。
  if (env().REPLY_VISION_ENABLED) {
    const imgFileId = message.imageFileId ?? message.replyTo?.imageFileId;
    if (imgFileId) {
      try {
        const { fetchImageDataUrl } = await import('../vision.js');
        const dataUrl = await fetchImageDataUrl(imgFileId);
        if (dataUrl) {
          for (let i = messages.length - 1; i >= 0; i--) {
            const m = messages[i]!;
            if (m.role === 'user') {
              messages[i] = {
                ...m,
                content: [
                  { type: 'image', image: dataUrl },
                  { type: 'text', text: typeof m.content === 'string' ? m.content : '' },
                ],
              };
              break;
            }
          }
          logger.info({ chatId, messageId: message.messageId }, 'reply vision: image attached to writer call');
          incrCounter('reply_vision_attach_total', { chat: chatId, outcome: 'ok' });
        }
      } catch (err) {
        logger.debug({ err, chatId }, 'reply vision attach failed (non-critical, text-only fallback)');
        incrCounter('reply_vision_attach_total', { chat: chatId, outcome: 'fail' });
      }
    }
  }

  // 合并写手:在 system 末尾加工具约束——工具是中间步,最终必须只吐 reply JSON。
  if (mergedToolsActive && messages[0]?.role === 'system') {
    const toolHint = directToolsActive
      ? '\n\n[工具]\n你可以调用工具(搜索/抓网页/回忆本群旧事/查群友画像)来回答你不确定的实时信息或旧事。' +
        '工具调用是中间步骤、不展示给用户;拿到结果后,**最终输出必须且只能是 reply JSON**' +
        '(格式与不调工具时完全一样)。闲聊能直接答就别调工具,别为一句话查半天。'
      : '\n\n[工具]\n你可以调用工具(查资料/借力本群其他 bot)来获取你不知道的实时信息。' +
        '工具调用是中间步骤、不展示给用户;拿到结果后,**最终输出必须且只能是 reply JSON**' +
        '(格式与不调工具时完全一样)。能直接答就别调工具。';
    const sysBase = typeof messages[0].content === 'string' ? messages[0].content : '';
    messages[0] = {
      ...messages[0],
      content: sysBase + toolHint,
    };
  }

  // 5. Call AI final writer.
  //   - 合并写手(mergedToolsActive):一次带工具调用,失败回退纯文本写手
  //   - 否则:纯文本写手(direct / 老两段 planned 都已把 TOOL_RESULTS 拼进 prompt)
  let result: Awaited<ReturnType<typeof generateReplyModelOutput>>;
  try {
    if (mergedToolsActive) {
      const { generateReplyWithTools } = await import('./reply-with-tools.js');
      const merged = await generateReplyWithTools({
        messages, usage, chatId, userId: message.uid, signal: interruptSignal,
        toolsOnly: directToolsActive ? DIRECT_TOOL_SUBSET : undefined,
      });
      // strip <think> 后再判空:think-only 响应原始 content 非空但剥完是空,以前会漏过空兜底变静默
      const mergedContent = merged.content ? stripThinking(merged.content) : '';
      const mergedPath = directToolsActive ? 'direct' : 'planned';
      incrCounter('reply_merged_writer_total', { path: mergedPath, outcome: !merged.failed && mergedContent ? 'ok' : 'fallback' });
      for (const t of merged.toolsUsed) incrCounter('reply_tools_used_total', { chat: chatId, tool: t });
      if (!merged.failed && mergedContent) {
        result = {
          content: mergedContent,
          toolsUsed: merged.toolsUsed,
          tokenUsage: merged.tokenUsage,
          model: merged.model,
          label: merged.label,
          latencyMs: merged.latencyMs,
        } as Awaited<ReturnType<typeof generateReplyModelOutput>>;
        toolsUsed = merged.toolsUsed;
      } else {
        // 合并写手挂了/空 → 退回纯文本写手(自带空响应重试,best-effort)
        result = await generateReplyModelOutput(messages, usage, { signal: interruptSignal });
        result.toolsUsed = toolsUsed;
      }
    } else {
      result = await generateReplyModelOutput(messages, usage, { signal: interruptSignal });
      result.toolsUsed = toolsUsed;
    }
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

  // 6.5 P5-C: 统一回复自检管线（guards.ts）——tool-artifact / exact-dup / near-dup
  // 三块原手写 regen 迁移为声明式 guard。行为语义完全保留：
  // - 空占位 regen 不覆盖第一版（防静默）
  // - 重试耗尽仍命中 → 保留第一版（已尽力）
  // - 检测自身抛错 = 跳过该 guard
  {
    const { runGuardPipeline } = await import('./guards.js');
    const regenerate = async (opts: { temperature: number; constraintHint?: string; instructionHint?: string }) => {
      let regenMessages = messages;
      if (opts.constraintHint) {
        regenMessages = messages.map((m, idx) =>
          idx === messages.length - 1 && m.role === 'user'
            ? appendReplyText(m, `\n\n[REGENERATE_CONSTRAINT]\n${opts.constraintHint}`)
            : m,
        );
      } else if (opts.instructionHint) {
        regenMessages = appendToolArtifactRetryInstruction(messages);
      }
      const out = await generateReplyModelOutput(regenMessages, usage, {
        temperatureOverride: opts.temperature,
        signal: interruptSignal,
      });
      out.toolsUsed = toolsUsed;
      result = out;
      return parseReplyResponse(out.content, message.messageId);
    };

    const guarded = await runGuardPipeline(
      [
        {
          name: 'tool-artifact',
          check: async (_c, d) =>
            d.some((r) => containsToolArtifact(r.replyContent)) ? { detail: 'artifact in draft' } : null,
          maxRetries: MAX_TOOL_ARTIFACT_RETRIES,
          temperature: 0,
          hintMode: 'instruction',
          // artifact 检查针对数组任一元素，accept 条件 = 全干净
          acceptRegen: async (_c, r) => !r.some((x) => containsToolArtifact(x.replyContent)),
        },
        {
          name: 'exact-dup',
          check: async (c, d) =>
            d[0] && (await isDuplicateReply(c, d[0].replyContent)) ? { detail: 'exact duplicate' } : null,
          maxRetries: MAX_DUPLICATE_RETRIES,
          temperature: 1.0,
          hintMode: 'none',
          acceptRegen: async (c, r) => !r[0] || !(await isDuplicateReply(c, r[0].replyContent)),
        },
        // G13 near-dup：ANTI_REPEAT_ENABLED 门控保留在 guard 内部
        ...(env().ANTI_REPEAT_ENABLED
          ? [{
              name: 'near-dup',
              check: async (c: number, d: typeof parsedReplies) => {
                if (!d[0]) return null;
                const dup = await checkNearDuplicate(c, d[0].replyContent);
                return dup.isNearDuplicate
                  ? { detail: 'near duplicate', collidedWith: dup.collidedWith ?? undefined, metric: dup.ratio }
                  : null;
              },
              maxRetries: 1,
              temperature: 1.0,
              hintMode: 'constraint' as const,
              acceptRegen: async (c: number, r: typeof parsedReplies) =>
                !r[0] || !(await checkNearDuplicate(c, r[0].replyContent)).isNearDuplicate,
            }]
          : []),
      ],
      parsedReplies,
      { chatId, regenerate, isBlank: isBlankReply },
    );
    // 管线可能返回 regen 版（result 已被 regenerate 内部更新）
    if (guarded !== parsedReplies) {
      logger.info({ chatId }, 'reply guard pipeline replaced draft with regenerated version');
    }
    parsedReplies = guarded;
  }

  // ── P5 归一化管线:动作拆分 ∘ 目标守卫 ∘ 占位过滤(幂等,所有 regen 必经)──
  // 此前 regen 路径(exactReplyCount 等)绕过这些守卫 → 整类数据丢失/逃逸 bug。
  const delegationMarkers = /(回复|回应|怼|评价|告诉|转告|提醒|帮我回|替我回|替我说|帮我和|代我)/;
  const userDelegated = delegationMarkers.test(message.textContent || '');
  let reactions: Array<{ targetMessageId: number; emoji: string }> | undefined;

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
    // 目标守卫:未委托时不许把回复挂到频道身份/bot 消息下(线上事故)。
    // 2026-07-04 放宽:本回合 burst 窗口(burstIds)与 G7 回访候选是**明确
    // 授权的目标集合**——连发里两个独立问题分别回、回访没人接的消息,
    // 指向它们不构成"回错人";守卫只拦窗口外的漂移目标。此前 G7 注入的
    // 跨人目标会被这里改写回提问者,回访特性自相矛盾地失效。bot/频道
    // 身份消息仍无条件改写(那是守卫要防的原始事故)。
    const allowedTargets = new Set<number>([
      ...(callOpts?.burstIds ?? []),
      ...(callOpts?.revisitCandidates?.map((c) => c.messageId) ?? []),
    ]);
    if (!userDelegated) {
      for (const p of texts) {
        if (!p.action && p.targetMessageId !== message.messageId) {
          const target = retrievedContext.merged.find((m) => m.messageId === p.targetMessageId);
          const targetIsOtherHuman =
            !!target &&
            !target.isBot &&
            !target.isAnonymous &&
            target.uid !== message.uid &&
            target.messageId !== message.replyTo?.messageId &&
            !allowedTargets.has(p.targetMessageId);
          if (target && (target.isBot || target.isAnonymous || targetIsOtherHuman)) {
            logger.info(
              { chatId, badTarget: p.targetMessageId, retargeted: message.messageId },
              'Reply targeted a non-asker message without delegation, retargeting to the asker',
            );
            p.targetMessageId = message.messageId;
          }
        }
      }
    }
    // 占位过滤:空输出兜底的 '…'、或模型直接吐的纯点号/省略号,都不算内容(发出去很蠢)
    if (texts.length > 0 && texts.every((p) => !p.action && isBlankReply(p.replyContent))) {
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
        ? appendReplyText(m, '\n\n[REGENERATE_CONSTRAINT]\n这是对你的直接指令,不允许沉默或只发贴纸。必须输出实际执行指令的文字回复;确实做不到就明确说做不到+原因。')
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
    (parsedReplies[0]!.replyContent.length > REPLY_SPLIT_CHAR_THRESHOLD ||
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
  const modelSilent = parsedReplies.length === 0 ? true : undefined;

  const latencyMs = Math.round(performance.now() - start);
  logger.info({
    chatId,
    action,
    replyPath: effectiveReplyPath,
    model: result.model,
    tokens: result.tokenUsage.total,
    latencyMs,
    toolsUsed: result.toolsUsed,
    replyCount: parsedReplies.length,
    replyLength: parsedReplies.map(r => r.replyContent.length),
    contextMessages: retrievedContext.merged.length,
    contextTokens,
    knowledgeChars: knowledge?.length ?? 0,
    burstCount: callOpts?.burstIds?.length ?? 0,
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
      voice: p.voice,
    })),
    toolsUsed: result.toolsUsed,
    toolExecutionFailed,
    reactions,
    modelSilent,
  };
}
