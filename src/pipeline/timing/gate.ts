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
import { isInGateCooldown } from './chat-runtime.js';

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
  // Cooldown: previous gate decision was wait/no_action and TTL not elapsed
  try {
    if (await isInGateCooldown(input.chatId)) {
      return makeShortCircuit('continue', 'cooldown_bypass', start);
    }
  } catch (err) {
    logger.debug({ err, chatId: input.chatId }, 'gate cooldown check failed (non-critical)');
  }

  // ── LLM call ──
  let systemPrompt = '';
  try {
    systemPrompt = loadCachedPrompt('task/timing-gate.md');
    if (!systemPrompt) throw new Error('timing-gate prompt not found');
    const modeBlock = input.proactiveMode
      ? `## 当前模式：主动评估（proactive）\n你不是被用户 @ 或回复。这是 bot 自己看到群里在聊有趣话题，想主动插一句。\n\n判断标准（与默认模式不同，请重点遵守这条）：\n- **不要**因为"没人@bot"就 no_action。麦麦本身就是群里普通成员，闲聊不需要被点名。\n- **该 wait** 的情况：用户 A 和用户 B 正在密集来回（最近 30 秒内连续互动），插进去会打断他们。\n- **该 no_action** 的情况：群里在讨论非常严肃 / 敏感话题（如争吵、负面情绪宣泄）、或最近一条消息是 bot 自己刚发的。\n- **可以 continue** 的情况：群里在闲聊 / 玩梗 / 分享 / 提问，并且没有用户 A↔B 正在密集对话；这种情况下你想加入就加入，自然得像群友。\n- 倾向 continue。后面还有回复生成的最后一道把关，不会乱说话。`
      : '';
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
  const userMsg =
    `[最近聊天上下文]\n${ctxStr}\n\n` +
    `[Judge 决策]\n${judgeSummary}\n\n` +
    `请基于以上信息判断节奏，输出符合 schema 的 JSON。`;

  const timeoutMs = e.TIMING_GATE_TIMEOUT_MS;

  let raw: string;
  try {
    const callPromise = callWithFallback({
      usage: e.TIMING_GATE_USAGE,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMsg },
      ],
      maxTokens: 200,
      temperature: 0,
    });

    const result = await Promise.race([
      callPromise,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('gate_timeout')), timeoutMs);
      }),
    ]);

    raw = result.content;
  } catch (err) {
    logger.warn({ err, chatId: input.chatId }, 'gate LLM call failed, fail-open continue');
    return makeShortCircuit('continue', 'llm_call_failed', start);
  }

  const parsed = parseGateResponse(raw);
  if (!parsed) {
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

  const decision: GateDecision = {
    action: parsed.action,
    waitSec: parsed.action === 'wait' ? clampWaitSec(parsed.waitSec) : undefined,
    reason: parsed.reason || 'llm',
    shortCircuited: false,
    latencyMs: Math.round(performance.now() - start),
    raw: raw.slice(0, 500),
  };

  logger.info(
    {
      chatId: input.chatId,
      action: decision.action,
      waitSec: decision.waitSec,
      reason: decision.reason,
      latencyMs: decision.latencyMs,
    },
    'Timing gate decision',
  );

  return decision;
}
