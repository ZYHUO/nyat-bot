// ────────────────────────────────────────
// Phase 3: Timing Gate — LLM-based rhythm control
// ────────────────────────────────────────
//
// Pipeline 在 judge=REPLY 之后、reply 之前调用。Gate 用一个轻量 LLM
// 输出三选一 JSON：continue / wait(N) / no_action。
//
//   continue  → pipeline 继续走原 reply 流程
//   wait(N)   → chat 进入 WAIT 状态，N 秒内不再回复（即便有新消息）
//   no_action → chat 进入 STOP 状态，新消息默认被屏蔽，直到 direct interaction 唤醒
//
// 调用约定：
//   - 仅在 TIMING_GATE_ENABLED=true 时启用
//   - 直接交互（mention/reply to self/private/command）跳过 gate（continue）
//   - cooldown 期间跳过 gate（continue），避免短时反复消耗 token
//   - 上一轮 judge.replyTier=max 时跳过 gate（用户都开 max 了别犹豫）
//   - LLM 失败 / 解析失败 / 超时 → fail-open continue，避免节奏控制误屏蔽

import type { FormattedMessage, JudgeResult } from '../../shared/types.js';
import { callWithFallback } from '../../ai/fallback.js';
import { slimContextForAI } from '../context/slim.js';
import { loadCachedPrompt } from '../../shared/config.js';
import { env } from '../../env.js';
import { logger } from '../../shared/logger.js';
import {
  getChatState,
  getGateCooldownRemainingMs,
  isInContinuation,
  type ChatTimingState,
} from './chat-runtime.js';
import { checkTalkValueThreshold } from './talk-value.js';
import { hasDeferBudget } from './defer.js';
import { appendGateHistory, formatGateHistoryBlock, getGateHistory } from './gate-history.js';

export type GateAction = 'continue' | 'wait' | 'no_action';

export interface GateDecision {
  action: GateAction;
  /** Only meaningful when action='wait'. Always within [WAIT_MIN_SEC, WAIT_MAX_SEC]. */
  waitSec?: number;
  reason: string;
  /** True when decision was made without an LLM call (rule / cooldown / fail-open). */
  shortCircuited: boolean;
  latencyMs: number;
  /** Raw model output (truncated). Only set when LLM was called. */
  raw?: string;
  /**
   * 冷却期延后(TURN_GATE_DEFER_COOLDOWN):跳过这次回复但**不**进入
   * STOP 状态——对齐 MaiBot 的"no_action 后拖时间"语义,而不是放行。
   */
  deferOnly?: boolean;
  /**
   * P0-B/P1-C:deferOnly 时的建议重评延迟(冷却剩余 / 预计攒够阈值的时间)。
   * pipeline 据此排 gate_defer 回合,到点带着这条消息重新评估。
   */
  retryAfterMs?: number;
  /**
   * P0-A:连续对话免检短路。pipeline 据此**跳过** recordGateContinue —— 免检
   * 本身不续窗,窗口只由真实 LLM continue 和真实 bot 回复刷新,防自续永动。
   */
  continuation?: boolean;
}

export interface GateInput {
  chatId: number;
  message: FormattedMessage;
  recentMessages: FormattedMessage[];
  judgeResult: JudgeResult;
  botUid: number;
  botName: string;
  botPersona: string;
  /** True when pipeline already determined this is a direct interaction. */
  isDirectInteraction: boolean;
  /**
   * True when called from proactive-scan cron (bot wants to chime in
   * unprompted). Adjusts gate prompt to be less restrictive about
   * "no one @ed me, so I shouldn't talk".
   */
  proactiveMode?: boolean;
  /** External abort signal (turn interrupt). Aborts the gate LLM call → fail-open continue. */
  signal?: AbortSignal;
  /** bot 上次发言距今秒数(在场感:刚说过话就别突然消失) */
  lastSpokeSecAgo?: number;
  triggerUid?: number;
  obligationId?: string;
  obligationTargetUid?: number;
  obligationStrong?: boolean;
  /** 审计 #38 风格:pipeline 已读过 timing state,传入避免 gate 内重复 HGETALL。 */
  prefetchedState?: ChatTimingState;
  /**
   * 多锚点同场兄弟:跳过 cooldown/talk-value 短路(与 turnContext.skipGateCooldown
   * 同源)。否则组1 的决策写入 lastGateAction 后组2 会被冷却误伤。
   */
  skipShortCircuits?: boolean;
  /**
   * true = 调用方(turn actor)支持 defer 延迟重评(P0-B);false 时 talk_value
   * 阈值层不生效 —— 未达阈值又无法重排等于丢消息。
   */
  canDefer?: boolean;
  /**
   * P0-B:该条消息已被 defer 的次数。预算耗尽时短路层不再 defer,直接
   * 放行给 LLM 裁决(兜底是"多烧一次 LLM",不是丢消息)。
   */
  deferCount?: number;
}

const VALID_ACTIONS = new Set<GateAction>(['continue', 'wait', 'no_action']);

function makeShortCircuit(
  action: GateAction,
  reason: string,
  start: number,
): GateDecision {
  return {
    action,
    reason,
    shortCircuited: true,
    latencyMs: Math.round(performance.now() - start),
  };
}

/**
 * Robust JSON parse for gate output. Handles ```json``` fences and trailing text.
 */
export function parseGateResponse(raw: string): GateDecision | null {
  let cleaned = raw.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  cleaned = cleaned.trim();

  // Try strict JSON first
  let obj: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(cleaned) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      obj = parsed as Record<string, unknown>;
    }
  } catch {
    // Try to extract a JSON object substring
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        const parsed = JSON.parse(m[0]) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          obj = parsed as Record<string, unknown>;
        }
      } catch {
        /* fall through */
      }
    }
  }

  if (!obj) {
    // Last-resort keyword match
    const lower = cleaned.toLowerCase();
    if (lower.includes('no_action') || lower.includes('no-action')) {
      return {
        action: 'no_action',
        reason: 'keyword-extracted',
        shortCircuited: false,
        latencyMs: 0,
      };
    }
    if (lower.includes('wait')) {
      const m = lower.match(/wait[^0-9]*(\d{1,4})/);
      const waitSec = m?.[1] ? Number(m[1]) : undefined;
      return {
        action: 'wait',
        waitSec,
        reason: 'keyword-extracted',
        shortCircuited: false,
        latencyMs: 0,
      };
    }
    if (lower.includes('continue')) {
      return {
        action: 'continue',
        reason: 'keyword-extracted',
        shortCircuited: false,
        latencyMs: 0,
      };
    }
    return null;
  }

  const actionRaw = String(
    (obj['action'] ?? obj['ACTION'] ?? '') as string,
  ).toLowerCase();
  if (!VALID_ACTIONS.has(actionRaw as GateAction)) return null;

  const reasonRaw = obj['reason'] ?? obj['REASON'] ?? '';
  const reason =
    typeof reasonRaw === 'string' ? reasonRaw.slice(0, 200) : '';

  let waitSec: number | undefined;
  const waitRaw = obj['waitSec'] ?? obj['wait_sec'] ?? obj['WAIT_SEC'];
  if (typeof waitRaw === 'number' && Number.isFinite(waitRaw)) {
    waitSec = Math.max(0, Math.floor(waitRaw));
  } else if (typeof waitRaw === 'string') {
    const n = Number(waitRaw);
    if (Number.isFinite(n)) waitSec = Math.max(0, Math.floor(n));
  }

  return {
    action: actionRaw as GateAction,
    waitSec,
    reason,
    shortCircuited: false,
    latencyMs: 0,
  };
}

function shouldProtectStrongObligation(input: GateInput): boolean {
  return input.obligationStrong === true && !!input.obligationId && !input.isDirectInteraction;
}

function clampWaitSec(raw: number | undefined): number {
  const e = env();
  const n = raw ?? Math.floor((e.TIMING_WAIT_MIN_SEC + e.TIMING_WAIT_MAX_SEC) / 2);
  return Math.min(Math.max(n, e.TIMING_WAIT_MIN_SEC), e.TIMING_WAIT_MAX_SEC);
}

/**
 * Run the timing gate. Always returns a decision (never throws); on errors
 * falls back to `continue` (fail-open) so the gate never blocks legitimate
 * replies on its own.
 */
export async function runTimingGate(input: GateInput): Promise<GateDecision> {
  const start = performance.now();
  const e = env();

  // ── Short-circuit gates ──
  if (!e.TIMING_GATE_ENABLED) {
    return makeShortCircuit('continue', 'gate_disabled', start);
  }
  if (input.isDirectInteraction) {
    return makeShortCircuit('continue', 'direct_interaction_bypass', start);
  }
  // Bypass gate for highest-tier replies (user explicitly invoked max)
  if (input.judgeResult.replyTier === 'max') {
    return makeShortCircuit('continue', 'reply_tier_max_bypass', start);
  }

  // 后续短路都要读 timing state:优先用 pipeline 预读快照(审计 #38),没有再读。
  let state: ChatTimingState | undefined = input.prefetchedState;
  if (state === undefined) {
    try {
      state = await getChatState(input.chatId);
    } catch (err) {
      logger.debug({ err, chatId: input.chatId }, 'gate state read failed (non-critical)');
    }
  }

  // P0-A 连续对话免检(MaiBot 连续 Planner):刚 continue 过 / bot 刚回复过的
  // 窗口内直接放行,不烧 LLM。proactive 不享受(主动插话不是"对话中")。
  // 注意在 cooldown 检查**之前**:比 bot 回复更旧的 no_action 冷却不该拦住
  // 对话中的接话。
  if (
    e.TURN_GATE_CONTINUATION &&
    !input.proactiveMode &&
    state &&
    isInContinuation(state)
  ) {
    return {
      ...makeShortCircuit('continue', 'continuation_window', start),
      continuation: true,
    };
  }

  // Cooldown: previous gate decision was wait/no_action and TTL not elapsed.
  // 默认(legacy)语义是 bypass→continue(放行);TURN_GATE_DEFER_COOLDOWN 把它
  // 改向为 MaiBot 语义:冷却期内不重判,这条先不回。P0-B 后 defer 不再是
  // 丢弃 —— 带 retryAfterMs 由 pipeline 排 defer-resume 到点重评;重放预算
  // 耗尽的条目不再 defer,**放行给 LLM 裁决**(review #1/#3:兜底方向是
  // 多烧一次 LLM,不是丢消息)。
  try {
    const remainingMs = await getGateCooldownRemainingMs(input.chatId, state);
    if (remainingMs > 0 && !input.skipShortCircuits) {
      if (e.TURN_GATE_DEFER_COOLDOWN) {
        // 与下面 talk-value 层的 `canDefer && budget` 故意不同:cooldown 层非 actor
        // (canDefer=false)→ deferOnly → 静默,是**正确**的("刚说过话,冷却期不该再回";
        // direct 消息在上游已短路,不受影响)。talk-value 层非 actor 必须穿透 LLM(否则
        // 慢群"未达阈值=永不回复")。codex #1 误把这个不一致当 bug,实为有意设计。
        if (!input.canDefer || hasDeferBudget(input.deferCount)) {
          return {
            ...makeShortCircuit('no_action', 'cooldown_defer', start),
            deferOnly: true,
            retryAfterMs: remainingMs,
          };
        }
        // 预算耗尽(actor)→ 穿透到 LLM
      } else {
        return makeShortCircuit('continue', 'cooldown_bypass', start);
      }
    }
  } catch (err) {
    logger.debug({ err, chatId: input.chatId }, 'gate cooldown check failed (non-critical)');
  }

  // P1-C talk_value 频率阈值(MaiBot runtime.py:636-669/1451-1504):确定性攒
  // 消息,未达阈值不烧 LLM,defer 到预计凑够的时刻。仅 canDefer(actor)生效
  // —— 否则未达阈值等于丢消息。连续免检(P0-A)优先于本层;defer 预算耗尽
  // 的条目跳过本层直接给 LLM(review #3:低 talk_value 的慢群否则会变成
  // 确定性永不回复区)。
  if (input.canDefer && hasDeferBudget(input.deferCount) && !input.proactiveMode && !input.skipShortCircuits && state) {
    try {
      const verdict = await checkTalkValueThreshold({ chatId: input.chatId, state });
      if (!verdict.pass) {
        logger.info(
          { chatId: input.chatId, threshold: verdict.threshold, count: verdict.count, equivalent: verdict.equivalent, retryAfterMs: verdict.retryAfterMs },
          'gate talk-value below threshold, defer',
        );
        return {
          ...makeShortCircuit('no_action', 'talk_value_below_threshold', start),
          deferOnly: true,
          retryAfterMs: verdict.retryAfterMs,
        };
      }
    } catch (err) {
      logger.debug({ err, chatId: input.chatId }, 'talk-value check failed (fail-open to LLM gate)');
    }
  }

  // ── LLM call ──
  let systemPrompt = '';
  try {
    systemPrompt = loadCachedPrompt('task/timing-gate.md');
    if (!systemPrompt) throw new Error('timing-gate prompt not found');
    const obligationBlock = shouldProtectStrongObligation(input)
      ? `## 未完成回复债务(obligation)\n当前存在一笔明确的未完成回复义务: obligationId=${input.obligationId}, targetUid=${input.obligationTargetUid ?? 'unknown'}。\n这意味着: \n- 不要因为群里后来出现别人的普通插话,就把这笔义务判成 no_action。\n- 若后续消息只是背景噪音/路人闲聊,优先 continue 或短 wait,而不是放弃这笔义务。\n- 只有在这笔义务明显已经翻篇、被同样明确的更高优先 direct 互动取代、或用户自己不需要回答了,才可 no_action。`
      : '';
    const modeBlock = input.proactiveMode
      ? `## 当前模式:主动插话(proactive)\n这次没有人 @ ${input.botName},是 ${input.botName} 自己看到群里在聊,想主动搭一句。判断标准和默认模式不同:\n- **不要**因为"没人点名"就 no_action——群友插话本来就不需要被点名,这正是本模式存在的意义。\n- **wait**:两个人正在密集一来一回(30 秒内连续互怼/互聊),现在挤进去是打断,等这波过去。\n- **no_action**:在吵架、在宣泄负面情绪、聊严肃敏感话题;或最近一条就是 ${input.botName} 自己发的。\n- **continue**:群里在闲聊/玩梗/分享/提问,且没有密集的二人对话——想加入就加入,自然得像群友。\n- 倾向 continue:后面还有写手最后一道把关,这里只看时机。`
      : '';
    systemPrompt = [systemPrompt, obligationBlock].filter(Boolean).join('\n\n');
    systemPrompt = systemPrompt
      .replace(/\{bot_name\}/g, input.botName)
      .replace(/\{bot_persona\}/g, input.botPersona || `${input.botName} 是群聊里的成员`)
      .replace(/\{wait_min_sec\}/g, String(e.TIMING_WAIT_MIN_SEC))
      .replace(/\{wait_max_sec\}/g, String(e.TIMING_WAIT_MAX_SEC))
      .replace(/\{mode_block\}/g, modeBlock);
  } catch (err) {
    logger.warn({ err }, 'gate prompt load failed, fail-open continue');
    return makeShortCircuit('continue', 'prompt_load_failed', start);
  }

  const ctxStr = slimContextForAI(input.recentMessages, input.message, input.botUid);
  const judgeSummary = `judge.action=${input.judgeResult.action} judge.rule=${input.judgeResult.rule ?? 'n/a'} judge.tier=${input.judgeResult.replyTier ?? 'normal'}`;
  // P1-D gate 有状态化(MaiBot:gate 与 planner 共享历史,看得到自己过往节奏
  // 判断):把最近几次真实 LLM 决策注入,防反复横跳/连续 wait 拖延。
  let historyBlock: string | undefined;
  if (e.TIMING_GATE_HISTORY_ENABLED) {
    try {
      historyBlock = formatGateHistoryBlock(await getGateHistory(input.chatId));
    } catch { /* non-critical */ }
  }
  // 在场感:刚参与过对话(≤3 分钟)→ 聊到一半突然消失非常突兀。
  // gate 历史上的 no_action 理由清一色"保持高傲/与我无关" —— 高傲是
  // 人设,但对话中途蒸发不是高傲,是故障。
  const presenceBlock = input.lastSpokeSecAgo !== undefined && input.lastSpokeSecAgo < 180
    ? `\n[在场感] 你 ${Math.round(input.lastSpokeSecAgo)} 秒前刚在这个群说过话,**正处于对话中**。对话进行中突然消失是很怪的——除非话题确实已经结束、或这条明显不是说给你的,否则倾向 continue。"高傲"体现在说话的语气里,不是体现在中途蒸发。\n`
    : '';
  const userMsg =
    `[最近聊天上下文]\n${ctxStr}\n\n` +
    `[Judge 决策]\n${judgeSummary}\n` +
    (historyBlock ? `\n${historyBlock}\n` : '') +
    `${presenceBlock}\n` +
    `请基于以上信息判断节奏，输出符合 schema 的 JSON。`;

  const timeoutMs = e.TIMING_GATE_TIMEOUT_MS;

  let raw: string;
  try {
    // Real abort on timeout (not Promise.race fire-and-forget) + external
    // turn-interrupt signal. Either firing cancels the underlying request.
    const result = await callWithFallback({
      usage: e.TIMING_GATE_USAGE,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMsg },
      ],
      maxTokens: 200,
      temperature: 0,
      // 与 heart/decision.ts 同因:超时预算必须是 per-attempt cap,不能
      // 烧进共享 signal(首跳超时会毒化整条 fallback 链)。gate 是
      // fail-open,所以旧 bug 在这里表现为"看似裁决过,实为全链 DOA 后
      // 的 continue" —— 比 heart 的静默吞回复隐蔽,但同样是假裁决。
      signal: input.signal,
      maxTimeoutMs: timeoutMs,
    });

    raw = result.content;
  } catch (err) {
    logger.warn({ err, chatId: input.chatId }, 'gate LLM call failed, fail-open continue');
    return makeShortCircuit('continue', 'llm_call_failed', start);
  }

  let parsed = parseGateResponse(raw);
  if (!parsed && !input.signal?.aborted) {
    // MaiBot 借鉴:解析失败先带纠正提示重试一次(gate 模型轻量,成本低)。
    // 直接 fail-open continue 会让 bot 在本该沉默的时机插嘴,破坏节奏感。
    // turn 已被打断时跳过重试 —— 别为注定要 replan 的回合再烧一轮 LLM。
    try {
      const retry = await callWithFallback({
        usage: e.TIMING_GATE_USAGE,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMsg },
          { role: 'assistant', content: raw.slice(0, 300) },
          { role: 'user', content: '上面的输出不是合法 JSON。只输出一个 JSON 对象,不要任何其他文字。' },
        ],
        maxTokens: 200,
        temperature: 0,
        signal: input.signal,
        maxTimeoutMs: timeoutMs,
      });
      parsed = parseGateResponse(retry.content);
      if (parsed) raw = retry.content;
    } catch { /* 重试失败走下面的 fail-open */ }
  }
  if (!parsed) {
    // P2-E (MaiBot reasoning_engine.py:607-615):全部尝试失败 → 按 no_action
    // 处理。fail-closed:宁可沉默,不要在本该沉默的时机插嘴。direct 已在
    // 上游 short-circuit(永远到不了这里);llm_call_failed(网络/超时)仍
    // fail-open——那是基础设施故障,不是模型说"我判不了"。
    if (e.TIMING_GATE_FAIL_CLOSED) {
      // review #2:合成 no_action 必须与 LLM no_action 同享强债务保护 ——
      // 否则解析失败会把 must-reply 债务直接标 dropped,用户永远等不到回复。
      if (shouldProtectStrongObligation(input)) {
        const waitSec = clampWaitSec(Math.max(e.TIMING_WAIT_MIN_SEC, 8));
        logger.warn(
          { chatId: input.chatId, obligationId: input.obligationId, rawSnippet: raw.slice(0, 200) },
          'gate parse failed, fail-closed → protected wait (strong obligation)',
        );
        return {
          action: 'wait',
          waitSec,
          reason: 'parse_failed_closed_protected',
          shortCircuited: false,
          latencyMs: Math.round(performance.now() - start),
          raw: raw.slice(0, 500),
        };
      }
      logger.warn(
        { chatId: input.chatId, rawSnippet: raw.slice(0, 200) },
        'gate parse failed, fail-closed no_action',
      );
      return {
        action: 'no_action',
        reason: 'parse_failed_closed',
        shortCircuited: false,
        latencyMs: Math.round(performance.now() - start),
        raw: raw.slice(0, 500),
      };
    }
    // codex #3:即使 fail-open(FAIL_CLOSED=false),内容审查拒答/空输出这类"模型
    // 明确判不了"的情况也不该 continue(那正是最不该插嘴的时机)——按 no_action 处理。
    // 只有真·非 JSON 的乱输出才 fail-open continue。
    const looksLikeRefusal = !raw.trim() ||
      /rejected|considered high risk|敏感|违规|无法(回答|处理|提供)|content.{0,12}(policy|filter)/i.test(raw);
    if (looksLikeRefusal) {
      logger.warn(
        { chatId: input.chatId, rawSnippet: raw.slice(0, 200) },
        'gate refusal/empty → no_action (fail-open path)',
      );
      return {
        action: 'no_action',
        reason: 'refusal_no_action',
        shortCircuited: false,
        latencyMs: Math.round(performance.now() - start),
        raw: raw.slice(0, 500),
      };
    }
    logger.warn(
      { chatId: input.chatId, rawSnippet: raw.slice(0, 200) },
      'gate parse failed, fail-open continue',
    );
    return {
      action: 'continue',
      reason: 'parse_failed',
      shortCircuited: false,
      latencyMs: Math.round(performance.now() - start),
      raw: raw.slice(0, 500),
    };
  }

  let action: GateAction = parsed.action;
  let waitSec = parsed.action === 'wait' ? clampWaitSec(parsed.waitSec) : undefined;
  let reason = parsed.reason || 'llm';

  if (parsed.action === 'no_action' && shouldProtectStrongObligation(input)) {
    action = 'wait';
    waitSec = clampWaitSec(parsed.waitSec ?? Math.max(env().TIMING_WAIT_MIN_SEC, 8));
    reason = (`protected_strong_obligation:${reason}`).slice(0, 200);
  }

  const decision: GateDecision = {
    action,
    waitSec: action === 'wait' ? waitSec : undefined,
    reason,
    shortCircuited: false,
    latencyMs: Math.round(performance.now() - start),
    raw: raw.slice(0, 500),
  };

  // P1-D:只记真实解析成功的 LLM 决策(短路/合成 no_action 不记),对齐
  // MaiBot"共享历史里只有 gate 自己真正说过的话"。fire-and-forget。
  if (e.TIMING_GATE_HISTORY_ENABLED) {
    void appendGateHistory(input.chatId, {
      action: decision.action,
      waitSec: decision.waitSec,
      reason: decision.reason,
      ts: Date.now(),
    }).catch(() => {});
  }

  logger.info(
    {
      chatId: input.chatId,
      action: decision.action,
      waitSec: decision.waitSec,
      reason: decision.reason,
      latencyMs: decision.latencyMs,
      triggerUid: input.triggerUid,
      obligationId: input.obligationId,
      obligationTargetUid: input.obligationTargetUid,
      obligationStrong: input.obligationStrong,
    },
    'Timing gate decision',
  );

  return decision;
}
