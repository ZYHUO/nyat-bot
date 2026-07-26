// ────────────────────────────────────────
// Multi-Agent Orchestrator — Router + 专家并行 fan-out + 核查 + Writer + Critic
// ────────────────────────────────────────
//
// 路由(零 LLM,复用 judge.replyPath+tier):
//   chat   → 记忆员 + 人设员 并行 → Writer(MULTI_AGENT_CHAT_SPECIALISTS 开时;
//            关则直奔 Writer,零额外延迟)
//   lookup → 研究员 + 记忆员 + 人设员 并行 → (核查员) → Writer → (Critic)
//   deep   → 研究员 + 记忆员 + 人设员 并行 → 核查员 → Writer → Critic(不行回炉1次)
//
// 通道分离(关键):研究员+核查员 → prebuiltToolResults(web 工具槽,writer 纯文本);
// 记忆员+人设员 → memoryFindings(走 knowledge 通道)。这样 researcher 失败时写手仍能走
// web 兜底(toolDecisionHandled=false),同时带着记忆员/人设员召回 —— 不会因它们的
// 产出而误禁用写手的 web 工具。
//
// 失败语义:专家 failed/超时 → 该专家产出留空;研究员 failed → toolDecisionHandled
// =false → 写手回退自己的 web 工具决策。turn 打断 → 从专家上抛 AI_ABORTED → replan。
// feature-flag 关时调用方走原 generateReply,本模块不参与。

import type { FormattedMessage, JudgeAction, ReplyPath, ReplyTier, RetrievedContext } from '../../shared/types.js';
import { generateReply } from '../reply/reply.js';
import { routeReply, routeNeedsSpecialists, routeIsDeep, type AgentRoute } from './router.js';
import { runResearcher } from './researcher.js';
import { runMemorySpecialist } from './memory-specialist.js';
import { runPersonaSpecialist } from './persona-specialist.js';
import { runDirector } from './director.js';
import { runContextDigest } from './context-digest.js';
import { runFactChecker } from './fact-checker.js';
import { runCritic } from './critic.js';
import { runPersonaCritic } from './persona-critic.js';
import { selectBestDraft } from './draft-selector.js';
import { isCallerAbort } from '../../shared/abort.js';
import { searchKnowledge } from '../../knowledge/manager.js';
import { recallEpisodes, type GroupEpisode } from '../../tracking/group-episodes.js';
import { env } from '../../env.js';
import { logger } from '../../shared/logger.js';

type ReplyCallOpts = NonNullable<Parameters<typeof generateReply>[8]>;
type ReplyResult = Awaited<ReturnType<typeof generateReply>>;

type SpecialistResult = { toolResultsBlock?: string; toolsUsed: string[]; failed: boolean } | null;

export interface MultiAgentInput {
  message: FormattedMessage;
  retrievedContext: RetrievedContext;
  action: JudgeAction;
  chatId: number;
  botUid: number;
  replyPath: ReplyPath | undefined;
  replyTier: ReplyTier | undefined;
  segmenterConfig?: Parameters<typeof generateReply>[7];
  turnCallOpts?: ReplyCallOpts;
}

/** turn 打断 → 上抛;其它错误吞掉(返回 null = 该专家无产出)。 */
function rethrowIfTurnAbort(reason: unknown, turnSignal: AbortSignal | undefined): void {
  if (isCallerAbort(turnSignal)) throw reason;
}

/** 某专家 settled → 取出成功产出;rejected → turn 打断上抛,否则记日志留空。 */
function settleSpecialist(
  settled: PromiseSettledResult<SpecialistResult>,
  turnSignal: AbortSignal | undefined,
  chatId: number,
  role: string,
  onValue: (block: string | undefined, tools: string[]) => void,
): void {
  if (settled.status === 'rejected') {
    rethrowIfTurnAbort(settled.reason, turnSignal);
    logger.debug({ err: settled.reason, chatId }, `Multi-agent: ${role} rejected (non-critical)`);
    return;
  }
  const v = settled.value;
  if (v && !v.failed) onValue(v.toolResultsBlock, v.toolsUsed);
}

/** deep 总跑 Critic;lookup 在 MULTI_AGENT_CRITIC_ON_LOOKUP 开时也跑;chat 不跑。 */
function routeRunsCritic(route: AgentRoute, e: ReturnType<typeof env>): boolean {
  if (!e.MULTI_AGENT_CRITIC_ENABLED) return false;
  if (routeIsDeep(route)) return true;
  if (route === 'lookup') return e.MULTI_AGENT_CRITIC_ON_LOOKUP;
  return false;
}

export async function runMultiAgentReply(input: MultiAgentInput): Promise<ReplyResult> {
  const e = env();
  const route = routeReply(input.replyPath, input.replyTier);
  const queryText = (input.message.textContent || input.message.captionContent || '').trim();
  const turnSignal = input.turnCallOpts?.signal;

  // 路由 → 该跑哪些专家。chat 路径默认只跑记忆员+人设员+导演+上下文digest
  // (MULTI_AGENT_CHAT_SPECIALISTS);lookup/deep 额外跑研究员。研究员只在 lookup/deep。
  const runResearcherFlag = routeNeedsSpecialists(route);
  const runGroundingFlag = routeNeedsSpecialists(route) || e.MULTI_AGENT_CHAT_SPECIALISTS;

  let researcherBlock: string | undefined;
  let memoryBlock: string | undefined;
  let personaBlock: string | undefined;
  let directorHint: string | undefined;
  let contextDigest: string | undefined;
  const specialistToolsUsed: string[] = [];
  let researcherFailed = true;

  if (runResearcherFlag || runGroundingFlag) {
    // 本地 KB 喂给各专家,避免对库里已有的东西再做 web 搜索/重复召回。
    let knowledge: string | undefined;
    try {
      knowledge = searchKnowledge(input.chatId, queryText, 5) || undefined;
    } catch { /* non-critical */ }

    const ctx = input.retrievedContext.contextStr ?? '';
    const commonArgs = { messageText: queryText, context: ctx, knowledge, chatId: input.chatId, userId: input.message.uid, turnSignal };
    const recentMsgCount = input.retrievedContext.merged?.length ?? 0;
    const heartWhy = input.turnCallOpts?.heartWhy;

    // ── Stage 1:全专家并行 fan-out(研究员/记忆员/人设员 agentic + 导演/上下文digest LLM)
    type Fan = { key: 'researcher' | 'memory' | 'persona' | 'director' | 'ctx'; p: Promise<unknown> };
    const fan: Fan[] = [];
    if (runResearcherFlag) fan.push({ key: 'researcher', p: runResearcher(commonArgs) });
    if (runGroundingFlag && e.MULTI_AGENT_MEMORY_ENABLED) fan.push({ key: 'memory', p: runMemorySpecialist(commonArgs) });
    // 人设员:单次直接查"对方"画像,需要发送者名字(fullName/username)
    const senderName = input.message.fullName || input.message.username || '';
    if (runGroundingFlag && e.MULTI_AGENT_PERSONA_ENABLED) fan.push({ key: 'persona', p: runPersonaSpecialist({ ...commonArgs, senderName }) });
    // M6:导演对"短上下文 + 无念头 + 非查询"的闲聊收益低,跳过省延迟(有念头/够长/lookup 仍跑)。
    const directorWanted = runGroundingFlag && e.MULTI_AGENT_DIRECTOR_ENABLED
      && (!!heartWhy || recentMsgCount >= 6 || runResearcherFlag);
    if (directorWanted) fan.push({ key: 'director', p: runDirector({ messageText: queryText, context: ctx, heartWhy, turnSignal }) });
    if (runGroundingFlag && e.MULTI_AGENT_CONTEXT_DIGEST_ENABLED) fan.push({ key: 'ctx', p: runContextDigest({ context: ctx, recentMsgCount, turnSignal }) });

    const settled = await Promise.allSettled(fan.map((f) => f.p));
    for (let i = 0; i < settled.length; i++) {
      const key = fan[i]!.key;
      const s = settled[i]!;
      if (key === 'researcher' || key === 'memory' || key === 'persona') {
        settleSpecialist(s as PromiseSettledResult<SpecialistResult>, turnSignal, input.chatId, key, (block, tools) => {
          if (key === 'researcher') { researcherFailed = false; researcherBlock = block; }
          else if (key === 'memory') memoryBlock = block;
          else personaBlock = block;
          specialistToolsUsed.push(...tools);
        });
      } else if (s.status === 'fulfilled') {
        const text = s.value as string | null;
        if (text) {
          if (key === 'director') directorHint = text;
          else contextDigest = text;
        }
      } else {
        rethrowIfTurnAbort(s.reason, turnSignal);
        logger.debug({ err: s.reason, chatId: input.chatId }, `Multi-agent: ${key} rejected (non-critical)`);
      }
    }

    logger.debug(
      { chatId: input.chatId, route, researcherFailed, researcherBlock: !!researcherBlock, memoryBlock: !!memoryBlock, personaBlock: !!personaBlock, directorHint: !!directorHint, contextDigest: !!contextDigest },
      'Multi-agent: specialists done',
    );

    // ── Stage 2:核查员(lookup + deep + 研究员有产出 + flag 开;有素材才核查)
    if (routeNeedsSpecialists(route) && e.MULTI_AGENT_CHECKER_ENABLED && researcherBlock) {
      try {
        const checkerBlock = await runFactChecker({
          messageText: queryText, researcherFindings: researcherBlock, turnSignal,
        });
        if (checkerBlock) researcherBlock = `${researcherBlock}\n\n${checkerBlock}`;
      } catch (err) {
        rethrowIfTurnAbort(err, turnSignal);
        logger.debug({ err, chatId: input.chatId }, 'Multi-agent: checker threw (non-critical)');
      }
    }
  }

  // 汇总:研究员(+核查)→ prebuiltToolResults;记忆员+人设员 → memoryFindings(独立通道);
  // 导演 → directorHint;上下文digest → contextDigest(独立 callOpt,不挤 knowledge)。
  const prebuiltToolResults = researcherBlock ?? undefined;
  const memoryFindings = [memoryBlock, personaBlock].filter(Boolean).join('\n\n') || undefined;
  const toolDecisionHandled = routeNeedsSpecialists(route) && !researcherFailed;

  // M3:群往事预取一次,best-of-N 多稿复用,避免 recallEpisodes 的 recall_count 被 ×N。
  let prefetchedEpisodes: GroupEpisode[] | undefined;
  try {
    prefetchedEpisodes = recallEpisodes(input.chatId, queryText, 2);
    if (prefetchedEpisodes.length === 0) prefetchedEpisodes = undefined;
  } catch { /* non-critical */ }

  // M4:不再因 extraFeedback 强制 toolDecisionHandled=true —— prebuilt 在场时写手
  // 本就会跳过内部 planner(toolResultsBlock truthy),无需额外禁用工具决策。
  const buildCallOpts = (prebuilt: string | undefined, extraFeedback?: string): ReplyCallOpts => {
    const prebuiltWithFeedback = extraFeedback
      ? `${prebuilt ? prebuilt + '\n\n' : ''}${extraFeedback}`
      : prebuilt;
    const base: ReplyCallOpts = input.turnCallOpts
      ? { ...input.turnCallOpts }
      : {};
    return {
      ...base,
      prebuiltToolResults: prebuiltWithFeedback,
      memoryFindings,
      directorHint,
      contextDigest,
      prefetchedEpisodes,
      toolDecisionHandled,
    };
  };

  // M2:写手会自己跑工具(planned + 研究员失败)时 best-of-N 降为单稿,
  // 避免并行多稿各自跑 agentic planner/搜索(重复搜索 + 速率限制风险)。
  const writerRunsTools = input.replyPath === 'planned' && !toolDecisionHandled;

  // ── Stage 3:Best-of-N 写手(并行 N 稿 + 选择器挑最优)
  const draftOpts = buildCallOpts(prebuiltToolResults);
  let result = await runBestOfNWriter(input, e, draftOpts, queryText, turnSignal, writerRunsTools);

  // ── Stage 4:深度 Critic 循环(deep 总跑;lookup 看 flag;回炉到通过或满 MAX_ROUNDS)
  // currentPrebuilt 累积 critic 反馈,Stage 5 复用(M1:人设 Critic 回炉带上 critic 反馈)。
  let currentPrebuilt = prebuiltToolResults;
  if (routeRunsCritic(route, e) && result.replies.length > 0) {
    for (let round = 0; round < e.MULTI_AGENT_CRITIC_MAX_ROUNDS; round++) {
      const draft = result.replies.map((r) => r.replyContent).filter(Boolean).join('\n');
      if (!draft) break;
      let verdict;
      try {
        verdict = await runCritic({ messageText: queryText, draft, findings: currentPrebuilt, turnSignal });
      } catch (err) {
        rethrowIfTurnAbort(err, turnSignal);
        logger.debug({ err, chatId: input.chatId }, 'Multi-agent: critic threw (non-critical)');
        break;
      }
      if (!verdict.needsRewrite || !verdict.feedback) break;
      logger.info({ chatId: input.chatId, round, feedback: verdict.feedback }, 'Multi-agent: critic rewrite');
      currentPrebuilt = `${currentPrebuilt ? currentPrebuilt + '\n\n' : ''}[二审反馈]\n${verdict.feedback}`;
      // 回炉的写手调用必须包在 try 里 —— 此刻 result 里已经有一份**通过初审、可直接发**的
      // 草稿。回炉若失败(label 链跑完 → AIError('All labels exhausted'),reply.ts 原样 rethrow)
      // 异常会穿过 runMultiAgentReply → writer-selector → deliver.ts:337(无 try)→ 落到
      // deliver 的兜底 catch → 用户收到"喵呜...本喵出了点小故障",那份好草稿被静默丢掉。
      // 而 BullMQ attempts:1 没有重试兜底。Stage 5 的人设 critic 回炉本来就是包在 try 里的
      // (:242-260,rewrite 失败保留旧 result)—— 这里漏了,语义对齐。
      try {
        result = await generateReply(
          input.message, input.retrievedContext, input.action,
          input.chatId, input.botUid, input.replyPath, input.replyTier,
          input.segmenterConfig, buildCallOpts(currentPrebuilt),
        );
      } catch (err) {
        rethrowIfTurnAbort(err, turnSignal);
        logger.warn({ err, chatId: input.chatId }, 'Multi-agent: critic rewrite failed, keeping approved draft');
        break;
      }
    }
  }

  // ── Stage 5:人设一致性 Critic(全路由,每条都查人设/关系;有问题回炉 1 次)
  if (e.MULTI_AGENT_PERSONA_CRITIC_ENABLED && result.replies.length > 0) {
    try {
      const draft = result.replies.map((r) => r.replyContent).filter(Boolean).join('\n');
      if (draft) {
        const verdict = await runPersonaCritic({ messageText: queryText, draft, turnSignal });
        if (verdict.needsRewrite && verdict.feedback) {
          logger.info({ chatId: input.chatId, feedback: verdict.feedback }, 'Multi-agent: persona-critic rewrite');
          // M1:在 currentPrebuilt(含 critic 反馈)之上追加 [人设反馈],两个 critic 反馈叠加。
          const personaPrebuilt = `${currentPrebuilt ? currentPrebuilt + '\n\n' : ''}[人设反馈]\n${verdict.feedback}`;
          result = await generateReply(
            input.message, input.retrievedContext, input.action,
            input.chatId, input.botUid, input.replyPath, input.replyTier,
            input.segmenterConfig, buildCallOpts(personaPrebuilt),
          );
          currentPrebuilt = personaPrebuilt;
        }
      }
    } catch (err) {
      rethrowIfTurnAbort(err, turnSignal);
      logger.debug({ err, chatId: input.chatId }, 'Multi-agent: persona-critic threw (non-critical)');
    }
  }

  if (specialistToolsUsed.length > 0 && result.toolsUsed.length === 0) {
    result.toolsUsed = specialistToolsUsed;
  }
  return result;
}

/** Best-of-N 写手:N 稿并行 → 选择器挑最优;N=1 / 选择器关 / 写手跑工具 → 单稿。
 *  H1:选择器下标对齐"有内容的候选"而非原始 ok,空稿不参与选择也不会被误选。
 *  turn 全打断 → 上抛。 */
async function runBestOfNWriter(
  input: MultiAgentInput,
  e: ReturnType<typeof env>,
  draftOpts: ReplyCallOpts,
  queryText: string,
  turnSignal: AbortSignal | undefined,
  writerRunsTools: boolean,
): Promise<ReplyResult> {
  // M2:写手会跑工具时强制单稿,避免多稿各自跑 planner/搜索。
  const n = (writerRunsTools || e.WRITER_BEST_OF_N <= 1 || !e.WRITER_SELECTOR_ENABLED) ? 1 : e.WRITER_BEST_OF_N;
  if (n <= 1) {
    return generateReply(
      input.message, input.retrievedContext, input.action,
      input.chatId, input.botUid, input.replyPath, input.replyTier,
      input.segmenterConfig, draftOpts,
    );
  }
  const draftPs = Array.from({ length: n }, () =>
    generateReply(
      input.message, input.retrievedContext, input.action,
      input.chatId, input.botUid, input.replyPath, input.replyTier,
      input.segmenterConfig, draftOpts,
    ),
  );
  const settled = await Promise.allSettled(draftPs);
  const ok = settled.filter((s): s is PromiseFulfilledResult<ReplyResult> => s.status === 'fulfilled').map((s) => s.value);
  if (ok.length === 0) {
    const firstRej = settled.find((s) => s.status === 'rejected') as PromiseRejectedResult;
    rethrowIfTurnAbort(firstRej.reason, turnSignal);
    throw firstRej.reason;
  }
  // H1:只在"有可见正文"的草稿里选,候选下标与选择器返回对齐;空稿既不被选也不会挤掉有内容的稿。
  const candidates = ok
    .map((r, i) => ({ r, i, text: r.replies.map((rr) => rr.replyContent).filter(Boolean).join('\n').trim() }))
    .filter((c) => c.text.length > 0);
  if (candidates.length === 0) return ok[0]!; // 全空(如 modelSilent)→ 用第一稿,下游自决
  if (candidates.length === 1) return candidates[0]!.r;
  const drafts = candidates.map((c) => c.text);
  const picked = await selectBestDraft({ messageText: queryText, drafts, turnSignal });
  logger.info({ chatId: input.chatId, n, picked }, 'Multi-agent: best-of-N selected');
  return candidates[picked]!.r ?? ok[0]!;
}
