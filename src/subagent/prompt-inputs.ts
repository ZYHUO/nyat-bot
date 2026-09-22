// ────────────────────────────────────────
// CodeAct prompt 准备 —— 把 executor 的串行 await 链改成依赖图并行
// ────────────────────────────────────────
//
// 2026-09-22 段⑤延迟整治。七天全量实测（n=2666 跑过 LLM 的任务）：
//   prompt 组装全程（task_started 事件 → "CodeAct task start" 日志）
//   p50 793ms / p90 3.4s，其中长期记忆块（向量检索）p50 ~590ms 是长板，
//   其余各自几 ms ~ 几十 ms 的段落却全程串行相加。
//
// 依赖图（改错顺序 = 查询词丢了锚点正文，测试能抓到，见
// tests/unit/subagent/prompt-inputs.test.ts）：
//
//   getRecent(80) ──┬─→ targetBlock(同步拼装, 含按需二次 getRecent(120))
//                   │      └─(anchorText)─┬─→ buildSubagentMemoryBlock
//                   │                      └─→ buildCognitiveWorkspace
//   recentMessageIds ──┘（memoryBlock 的 excludeMessageIds 同源）
//
//   其余全部互不依赖：journal / scratch / chatStyle / identity / recentContext /
//   permanent / roster / selfState / experience / skills / world-state / policies /
//   grounding（单次 take）/ relationship / replyCmds / self-play prompt。
//   动态 import 也在第一阶段一次性并发预热（首次执行省重复的模块加载排队）。
//
// 每一段各自 try/catch：任何一段抛异常只把自己降级成空串，executor 照常拿到
// prompt——与改动前逐段 /* optional */ 的语义完全一致。

import { env } from '../env.js';
import { logger } from '../shared/logger.js';
import { isDM } from '../shared/chat.js';
import { applySandboxAvailabilityNotes } from './sandbox-prompt.js';
import { getSandboxCapability } from '../sandbox/terminal.js';
import type { DispatchTask } from '../meta/types.js';
import type { HostApi } from './host-api.js';

/** 最近聊天行（context/manager.getRecent 的元素）。 */
type RecentMessage = Awaited<ReturnType<typeof import('../pipeline/context/manager.js').getRecent>>[number];
/** 回复式 bot 命令清单元素。 */
type ReplyCommand = Awaited<ReturnType<typeof import('../learners/bot-command-store.js').listReplyInvocableCommands>>[number];

/** collectPromptInputs 的产物：executor 组装最终 prompt 所需的全部原料。 */
export interface PromptInputs {
  journal: string;
  journalChannelLink: string | null;
  journalChatId: number;
  scratchBlock: string;
  chatStyleLine: string;
  identity: string;
  masterBlock: string;
  recentCtx: string;
  permanent: string;
  roster: string;
  /** 本轮必须回的那一句（含 reply 链/父消息）。getRecent 的结果派生。 */
  targetBlock: string;
  /** 锚点正文，memory/workspace 的查询词来源（依赖 getRecent，勿提前）。 */
  anchorText: string;
  memoryBlock: string;
  selfStateLine: string;
  /** 已按原顺序拼好的 systemPrompt（含经验/技能/世界状态/循环策略追加）。 */
  systemPrompt: string;
  injectedExperienceIds: number[];
  injectedSkillIds: number[];
  injectedSkillNames: string[];
  injectedPolicyIds: number[];
  groundingBlock: string;
  relationshipBlock: string;
  workspaceBlock: string;
}

export interface CollectPromptInputsCtx {
  task: DispatchTask;
  host: HostApi;
  isSelfPlay: boolean;
  /** task.quoteMessageIds[0] 兜底解析出的锚点；无锚点时 undefined。 */
  replyAnchor: number | undefined;
  /** EXECUTOR_SYSTEM 原文（留在 executor.ts，sandbox-params/sandbox-prompt 测试要正则解析它）。 */
  executorSystem: string;
}

export async function collectPromptInputs(ctx: CollectPromptInputsCtx): Promise<PromptInputs> {
  const { task, host, isSelfPlay, replyAnchor, executorSystem } = ctx;
  const { chatId } = task;
  const group = chatId < 0;

  // ── 第一阶段：互不依赖的全部并发 ──────────────────────────────────────
  const [
    journalRes,
    scratchBlock,
    chatStyleLine,
    identity,
    recentCtx,
    masterBlock,
    permanent,
    roster,
    selfStateLine,
    experience,
    skills,
    worldStateBlock,
    policies,
    groundingBlock,
    relationshipBlock,
    replyCmds,
    selfPlayPrompt,
    recent,
  ] = await Promise.all([
    // 日记片段 + 频道信息（段内两个调用互不依赖）
    (async () => {
      try {
        const { readRecentDreamSnippet, getJournalChannelInfo } = await import('../cron/dream-journal.js');
        const [snippet, info] = await Promise.all([
          readRecentDreamSnippet(300),
          getJournalChannelInfo(),
        ]);
        return {
          journal: snippet ?? '',
          info: info ? { link: info.link, chatId: info.chatId } : null,
        };
      } catch {
        return { journal: '', info: null as { link: string; chatId: number } | null };
      }
    })(),
    // P5-B 工作记忆：先回填进程缓存再读（两步有依赖，留在段内串行）
    (async () => {
      try {
        const { warmScratchCache, scratchPromptBlockSync } = await import('../tracking/scratchpad.js');
        await warmScratchCache(chatId);
        return scratchPromptBlockSync(chatId) ?? '';
      } catch { return ''; }
    })(),
    // 群风格（长度镜像/引用率/标点漂移）——仅群聊
    (async () => {
      if (isDM(chatId)) return '';
      try {
        const { getChatStyle, chatStylePromptLine } = await import('../tracking/chat-style.js');
        return chatStylePromptLine(await getChatStyle(chatId));
      } catch { return ''; }
    })(),
    (async () => {
      try {
        const { buildCodeActIdentityPrompt } = await import('../pipeline/reply/prompt-builder.js');
        return buildCodeActIdentityPrompt(task.targetUserId);
      } catch { return ''; }
    })(),
    (async () => {
      try { return await host.memory.recentContext(60); } catch { return ''; }
    })(),
    (async () => {
      try {
        const { buildMasterIdentityBlock } = await import('../shared/master-identity.js');
        return buildMasterIdentityBlock();
      } catch { return ''; }
    })(),
    (async () => {
      try {
        const { loadCachedPrompt } = await import('../shared/config.js');
        return loadCachedPrompt('knowledge/permanent.md').slice(0, 1600);
      } catch { return ''; }
    })(),
    // Roster——persona 认人依赖 [群成员]；仅群聊
    (async () => {
      if (!group) return '';
      try {
        const { getCachedRoster, setCachedRoster } = await import('../pipeline/reply/member-cache.js');
        const cached = getCachedRoster(chatId);
        if (cached) return cached;
        const { getGroupMembers } = await import('../pipeline/context/manager.js');
        const members = await getGroupMembers(chatId);
        if (members.length) {
          const text = members
            .slice(0, 50)
            .map((m) => {
              const tag = m.username ? `@${m.username}` : `uid:${m.uid}`;
              return `${tag} = ${m.fullName}`;
            })
            .join('\n');
          setCachedRoster(chatId, text);
          return text;
        }
        return '';
      } catch { return ''; }
    })(),
    (async () => {
      try {
        const { composeSelfState } = await import('../pipeline/heart/self-state.js');
        const ss = await composeSelfState(chatId);
        return ss?.narration ?? '';
      } catch { return ''; }
    })(),
    // AGI L4 P4-A 过往经验（含 L5 预算截断）
    (async () => {
      try {
        const { findRelevantExperience } = await import('../agent/episodes.js');
        const hints = findRelevantExperience(task.contentDirection, 3, {
          botId: env().BOT_USERNAME ?? 'self',
          allowShared: env().EXPERIENCE_SHARE_ENABLED,
        });
        if (!hints.length) return { block: '', ids: [] as number[] };
        let picked: typeof hints = hints;
        if (env().RECALL_BUDGET_ENABLED) {
          const { applyRecallBudget } = await import('../agent/recall-budget.js');
          picked = applyRecallBudget(hints, env().RECALL_MAX_EXPERIENCE) as typeof hints;
        }
        return {
          block:
            `\n\n[过往经验]\n${picked.map((h) => `- (${h.kind}) ${h.content}`).join('\n')}\n以上是之前做类似事总结的教训，能用就用，不适用就忽略。`,
          ids: picked.map((h) => h.id),
        };
      } catch { return { block: '', ids: [] as number[] }; }
    })(),
    // 自我技能沉淀
    (async () => {
      try {
        const { findRelevantSkills } = await import('../agent/skills.js');
        const found = findRelevantSkills(task.contentDirection, 2);
        if (!found.length) return { block: '', ids: [] as number[], names: [] as string[] };
        return {
          block:
            `\n\n[可用技能]\n${found
              .map((s) => `- 【${s.name}】${s.summary ?? s.triggerWhen}\n  触发: ${s.triggerWhen}\n  做法: ${s.steps}${s.pitfalls ? `\n  坑: ${s.pitfalls}` : ''}`)
              .join('\n')}\n以上是你自己沉淀的技能，相关就用，不适用就忽略。`,
          ids: found.map((s) => s.id),
          names: found.map((s) => s.name),
        };
      } catch { return { block: '', ids: [] as number[], names: [] as string[] }; }
    })(),
    // AGI L5 Phase 6 世界状态
    (async () => {
      if (!env().WORLD_STATE_ENABLED) return '';
      try {
        const { buildWorldStateBlock } = await import('../agent/world-state.js');
        return buildWorldStateBlock(task.contentDirection, 4, {
          visibility: 'task',
          taskId: task.id,
          chatId,
        });
      } catch { return ''; }
    })(),
    // AGI L5 Phase 4 循环策略
    (async () => {
      if (!env().LOOP_POLICY_ENABLED) return { block: '', ids: [] as number[] };
      try {
        const { listActivePolicies } = await import('../agent/loop-policy.js');
        const found = listActivePolicies(env().LOOP_POLICY_MAX);
        if (!found.length) return { block: '', ids: [] as number[] };
        return {
          block:
            '\n\n[循环策略]\n' +
            found.map((p) => `- ${p.rule}`).join('\n') +
            '\n以上是过往任务沉淀的循环策略,适用就用。',
          ids: found.map((p) => p.id),
        };
      } catch { return { block: '', ids: [] as number[] }; }
    })(),
    // Grounding：dispatch 时后台起的联网核查。**只做一次 take，不轮询**——
    // 7 天实测：digest 到达需 3–6s，注入命中率仅 0.9%（25/2666），
    // 而为它轮询的任务 100% 多付最多 6s 串行延迟。放在这里与其余准备并行，
    // 拿不到就没有（grounding 本来就是 best-effort）。
    (async () => {
      try {
        const { takeGroundingBlock } = await import('../meta/grounding.js');
        return await takeGroundingBlock({ chatId, messageId: replyAnchor, taskId: task.id });
      } catch { return ''; }
    })(),
    // 好感度→语气分化
    (async () => {
      if (!(task.targetUserId && task.targetUserId > 0)) return '';
      try {
        const { getRelationship, relationshipPromptHint, newcomerPromptHint } = await import(
          '../tracking/relationship.js'
        );
        const rel = getRelationship(chatId, task.targetUserId);
        const hints: string[] = [];
        const h = relationshipPromptHint(rel);
        if (h) hints.push(h);
        const newcomer = newcomerPromptHint(rel.count);
        if (newcomer) hints.push(newcomer);
        if (!hints.length) return '';
        return `## 和对方的关系\n${hints.join('\n')}`;
      } catch { return ''; }
    })(),
    // 「当前能借力的 bot 命令」实时清单（替换 systemPrompt 里的写死散文）。
    // 返回 null = 读取失败（保留原句）；返回 [] = 真的一条都没有（删括号）。
    (async () => {
      try {
        const { listReplyInvocableCommands } = await import('../learners/bot-command-store.js');
        return listReplyInvocableCommands();
      } catch { return null; }
    })(),
    // self-play 任务用自己的 prompt（替换 EXECUTOR_SYSTEM）
    (async () => {
      if (!isSelfPlay) return '';
      try {
        const { loadCachedPrompt } = await import('../shared/config.js');
        return loadCachedPrompt('task/self-play.md');
      } catch { return ''; }
    })(),
    // 最近聊天 —— targetBlock / memoryBlock / workspace 的共同数据源，
    // 必须先于它们（见第二阶段）。无锚点时不查（与原逻辑一致）。
    (async () => {
      if (!replyAnchor || replyAnchor <= 0) return [] as RecentMessage[];
      try {
        const { getRecent } = await import('../pipeline/context/manager.js');
        return await getRecent(chatId, 80, task.messageThreadId);
      } catch { return [] as RecentMessage[]; }
    })(),
  ]);

  // ── 第二阶段：依赖 getRecent 的部分 ──────────────────────────────────
  // targetBlock 同步拼装（原来的 try/catch 语义保留：任何意外 → 兜底句）。
  let targetBlock = '';
  let anchorText = '';
  const recentMessageIds = new Set<number>();
  if (replyAnchor && replyAnchor > 0) {
    try {
      for (const m of recent) recentMessageIds.add(m.messageId);
      const hit = recent.find((m) => m.messageId === replyAnchor && m.role !== 'assistant');
      if (hit) {
        anchorText = (hit.textContent || '').slice(0, 240);
        const who = hit.username ? `@${hit.username}` : hit.fullName || `uid:${hit.uid}`;
        const userText = (hit.textContent || '').slice(0, 240);
        const { isShortFollowUpText, isBarePingText } = await import('../meta/reply-context.js');
        const followUp = isShortFollowUpText(userText) || isBarePingText(userText);
        // ── reply 链：本条回的是哪条 ──
        // （广告举报要带上父消息 #id 的完整理由见 executor.ts 历史注释）
        const parent = hit.replyTo;
        const parentLine = parent && parent.messageId > 0
          ? `#${replyAnchor} 回复的是 #${parent.messageId} ${parent.fullName || `uid:${parent.uid}`}: ${(parent.textSnippet || '（无正文，可能是图片/文件/ sticker）').slice(0, 160)}\n`
            + `   ↑ 要处理/举报**上面这条 #${parent.messageId}** 时（例如 bots.command 的 /spam 回复式代罚），用这个 id。\n`
          : '';
        targetBlock =
          `## 本轮必须回的那一句\n` +
          `#${replyAnchor} ${who}: ${userText || '（几乎无正文，可能是 reply+@）'}\n` +
          parentLine +
          (followUp
            ? `这是短接话/催问——必须结合下面「最近几句」继续同一话题，禁止当新开场（在听/怎么啦/想听什么）。禁止复读用户原话。`
            : `接住这一句的意思，并结合最近聊天；禁止复读用户原话，也别无故复读自己上一句。`);

        // Trailing thread for short follow-ups (DM「快点告诉我」 after food tease).
        if (followUp && recent.length) {
          const idx = recent.findIndex((m) => m.messageId === replyAnchor);
          const window = (idx >= 0 ? recent.slice(Math.max(0, idx - 6), idx) : recent.slice(-6)).filter(
            (m) => m.messageId !== replyAnchor,
          );
          if (window.length) {
            const lines = window.map((m) => {
              const w =
                m.role === 'assistant'
                  ? '你'
                  : m.username
                    ? `@${m.username}`
                    : m.fullName || `uid:${m.uid}`;
              return `#${m.messageId} ${w}: ${(m.textContent || '').slice(0, 160)}`;
            });
            targetBlock +=
              `\n\n## 最近几句（接话必读）\n` + lines.join('\n') + `\n顺着这个话题回，不要装作没听过。`;
          }
        }

        // Explicit parent bubble — legacy reply path had this; bare @+reply otherwise greets.
        const parentId = hit.replyTo?.messageId;
        if (parentId && parentId > 0) {
          let parent = recent.find((m) => m.messageId === parentId);
          if (!parent) {
            const { getRecent } = await import('../pipeline/context/manager.js');
            const wider = await getRecent(chatId, 120, task.messageThreadId);
            parent = wider.find((m) => m.messageId === parentId);
          }
          const parentWho = parent
            ? parent.username
              ? `@${parent.username}`
              : parent.fullName || `uid:${parent.uid}`
            : hit.replyTo?.fullName || '某人';
          const parentBody = (
            parent?.textContent ||
            hit.replyTo?.textSnippet ||
            ''
          ).slice(0, 1800);
          if (parentBody) {
            targetBlock +=
              `\n\n## 用户正在回复的原消息（必读）\n` +
              `#${parentId} ${parentWho}: ${parentBody}\n` +
              `用户本条若只有 @/很短，是在拉你看上面这段——针对其论点接话，禁止空问候（在呢/怎么啦）。`;
          }
        }
      } else {
        targetBlock = `## 本轮必须回的那一句\nmessageId=#${replyAnchor}（正文见最近聊天）。结合上下文接话，禁止复读自己上一句。`;
      }
    } catch {
      targetBlock = `## 本轮必须回的那一句\nmessageId=#${replyAnchor}`;
    }
  }

  // memoryBlock 与 workspace 都只依赖 anchorText/recentMessageIds（已就绪），
  // 二者互不依赖 → 并发。两者各自永不抛（内部有硬超时/兜底）。
  const [memoryBlock, workspaceBlock] = await Promise.all([
    (async () => {
      try {
        const { buildSubagentMemoryBlock } = await import('./memory-context.js');
        // 查询词 = 本轮要回的那句 + 任务方向。只用方向会太笼统(它是「短方向」不是台词),
        // 只用锚点正文则在「快点告诉我」这类短接话上几乎没有信息量,两者相加最稳。
        const query = [anchorText, task.contentDirection].filter(Boolean).join(' ').slice(0, 200);
        return await buildSubagentMemoryBlock({
          chatId,
          query,
          // 最近聊天里已有的不重复贴,否则同一条消息在 prompt 里出现两次。
          excludeMessageIds: recentMessageIds,
        });
      } catch {
        /* non-critical — 调用点再兜一层,异常绝不能冒泡进 CodeAct 主链路 */
        return '';
      }
    })(),
    (async () => {
      try {
        const { buildCognitiveWorkspace, renderCognitiveWorkspace } = await import('../agent/cognitive-workspace.js');
        const workspace = await buildCognitiveWorkspace({
          chatId,
          taskId: task.id,
          userId: task.targetUserId,
          queryText: (anchorText || task.contentDirection).slice(0, 800),
          asOfEventId: task.cognitiveAnchorEventId,
        });
        return renderCognitiveWorkspace(workspace);
      } catch (err) {
        logger.debug({ err, taskId: task.id }, 'cognitive workspace unavailable');
        return '';
      }
    })(),
  ]);

  // ── systemPrompt 链（同步字符串操作，顺序与原实现逐行一致） ────────────
  // 原顺序：EXECUTOR_SYSTEM → 沙盒可用性注记 → 回复式命令清单替换 →
  //         self-play 整体替换 → 经验 → 技能 → 世界状态 → 循环策略。
  let systemPrompt = applySandboxAvailabilityNotes(executorSystem, getSandboxCapability());
  if (replyCmds === null) {
    // 读不到命令清单就保留原句——至少那是 09-20 的真实快照，比空白好
  } else if (replyCmds.length > 0) {
    const rendered = replyCmds
      .map((c) => `/${c.command.replace(/^\//, '')}@${c.bot}${c.usageSyntax && c.usageSyntax !== c.command ? `（${c.usageSyntax}）` : ''}`)
      .join('、');
    systemPrompt = systemPrompt.replace(
      /（当前 = [^）]*）/,
      `（**当前真过得去闸的回复式命令：${rendered}**——以这份为准，别用记忆里的旧名单）`,
    );
  } else {
    // 一条都没有：把"当前 = …"那截括号整个删掉，别说一个不存在的名字
    systemPrompt = systemPrompt.replace(/（当前 = [^）]*）/,'');
  }
  if (selfPlayPrompt) systemPrompt = selfPlayPrompt;
  if (experience.block) {
    systemPrompt += experience.block;
    logger.info(
      { taskId: task.id, hintCount: experience.ids.length, ids: experience.ids },
      'experience recall injected',
    );
  }
  if (skills.block) {
    systemPrompt += skills.block;
    logger.info(
      { taskId: task.id, skillCount: skills.ids.length, names: skills.names },
      'skill recall injected',
    );
  }
  if (worldStateBlock) systemPrompt += worldStateBlock;
  if (policies.block) {
    systemPrompt += policies.block;
    logger.info({ taskId: task.id, policyCount: policies.ids.length }, 'loop policies injected');
  }

  return {
    journal: journalRes.journal,
    journalChannelLink: journalRes.info?.link ?? null,
    journalChatId: journalRes.info?.chatId ?? 0,
    scratchBlock,
    chatStyleLine,
    identity,
    masterBlock,
    recentCtx,
    permanent,
    roster,
    targetBlock,
    anchorText,
    memoryBlock,
    selfStateLine,
    systemPrompt,
    injectedExperienceIds: experience.ids,
    injectedSkillIds: skills.ids,
    injectedSkillNames: skills.names,
    injectedPolicyIds: policies.ids,
    groundingBlock,
    relationshipBlock,
    workspaceBlock,
  };
}
