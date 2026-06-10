// ────────────────────────────────────────
// 心流判断 — 一颗心代替三个过滤器(S13/G8 正主)
// ────────────────────────────────────────
//
// 旧链路:judge L1(无人格置信门)→ 可能 L2 → gate(半人格)——三次
// LLM 调用,三套独立 prompt,沉默由不认识人格的过滤器裁决,而"克制
// 与热情"恰恰是人格最重要的表达。
//
// 新链路:L0 规则未命中的被动群消息走**一次**心流调用:人格带着
// "此刻的自我状态"读房间,自己决定 reply/wait/pass。判断和写作共用
// 同一个自我叙述 —— 决定接不接的我和决定怎么说的我是同一个我。
//
// 还更便宜:1 次调用 ≤ 旧的 1-3 次。HEART_ENABLED 门控,关掉回旧链路。

import type { FormattedMessage, JudgeResult } from '../../shared/types.js';
import { callWithFallback } from '../../ai/fallback.js';
import { slimContextForAI } from '../context/slim.js';
import { loadCachedPrompt } from '../../shared/config.js';
import { mergeAbortSignals } from '../../shared/abort.js';
import { env } from '../../env.js';
import { logger } from '../../shared/logger.js';
import type { SelfState } from './self-state.js';

export type HeartAct = 'reply' | 'wait' | 'pass';

export interface HeartDecision {
  act: HeartAct;
  /** act=reply 时:chat(直说)/ lookup(需要查资料 → planned 路径) */
  path: 'chat' | 'lookup';
  why: string;
  latencyMs: number;
  /** 折算出的 JudgeResult(供下游 mute/intercept/telemetry 沿用既有形状) */
  judgeResult: JudgeResult;
}

export interface HeartInput {
  chatId: number;
  message: FormattedMessage;
  recentMessages: FormattedMessage[];
  botUid: number;
  botName: string;
  selfState: SelfState;
  /** bot 上次发言距今秒数(在场感) */
  lastSpokeSecAgo?: number;
  /** 连发提示(G4):★ 锚点是一波 N 条连发的末尾,整体评估 */
  burstNote?: string;
  signal?: AbortSignal;
}

function parseHeart(raw: string): { act: HeartAct; path: 'chat' | 'lookup'; why: string } | null {
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const obj = JSON.parse(m[0]) as Record<string, unknown>;
    const act = String(obj['act'] ?? '').toLowerCase();
    if (act !== 'reply' && act !== 'wait' && act !== 'pass') return null;
    const pathRaw = String(obj['path'] ?? 'chat').toLowerCase();
    return {
      act: act as HeartAct,
      path: pathRaw === 'lookup' ? 'lookup' : 'chat',
      why: String(obj['why'] ?? '').slice(0, 40),
    };
  } catch {
    return null;
  }
}

function toJudgeResult(act: HeartAct, path: 'chat' | 'lookup', latencyMs: number): JudgeResult {
  if (act === 'pass') {
    return { action: 'IGNORE', level: 'L2_AI', rule: 'heart', confidence: 1, latencyMs };
  }
  return {
    action: 'REPLY',
    level: 'L2_AI',
    rule: 'heart',
    replyPath: path === 'lookup' ? 'planned' : 'direct',
    replyTier: 'normal',
    confidence: 1,
    latencyMs,
  };
}

/**
 * 心流判断。永不 throw:LLM 失败 → fail-closed pass(被动消息少接一条
 * 比误抢话安全;直接交互根本不经过这里)。
 */
export async function heartDecision(input: HeartInput): Promise<HeartDecision> {
  const start = performance.now();
  const e = env();

  let systemPrompt: string;
  try {
    let personaCore = '';
    try {
      personaCore = loadCachedPrompt('identity/persona.md').slice(0, 700);
    } catch { /* persona optional for the heart call */ }
    systemPrompt = loadCachedPrompt('task/heart.md')
      .replace(/\{bot_name\}/g, input.botName)
      .replace(/\{persona_core\}/g, personaCore || `${input.botName} 是群聊里的猫娘成员`)
      .replace(/\{self_state\}/g, input.selfState.narration);
  } catch (err) {
    logger.warn({ err }, 'heart prompt load failed, fail-closed pass');
    const latencyMs = Math.round(performance.now() - start);
    return { act: 'pass', path: 'chat', why: 'prompt_load_failed', latencyMs, judgeResult: toJudgeResult('pass', 'chat', latencyMs) };
  }

  const ctxStr = slimContextForAI(input.recentMessages, input.message, input.botUid);
  const presence = input.lastSpokeSecAgo !== undefined && input.lastSpokeSecAgo < 180
    ? `\n(你 ${Math.round(input.lastSpokeSecAgo)} 秒前刚在这个群说过话,正处于对话中)`
    : '';
  const burstLine = input.burstNote ? `\n${input.burstNote}` : '';
  const userMsg = `[群聊上下文]\n${ctxStr}${presence}${burstLine}\n\n对 ★ 标记的最新消息做出你的决定,输出 JSON。`;

  let raw: string;
  try {
    const result = await callWithFallback({
      usage: e.TIMING_GATE_USAGE,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMsg },
      ],
      maxTokens: 120,
      temperature: 0,
      signal: mergeAbortSignals(e.TIMING_GATE_TIMEOUT_MS, input.signal),
    });
    raw = result.content;
  } catch (err) {
    const latencyMs = Math.round(performance.now() - start);
    logger.warn({ err, chatId: input.chatId }, 'heart LLM failed, fail-closed pass');
    return { act: 'pass', path: 'chat', why: 'llm_failed', latencyMs, judgeResult: toJudgeResult('pass', 'chat', latencyMs) };
  }

  const parsed = parseHeart(raw);
  const latencyMs = Math.round(performance.now() - start);
  if (!parsed) {
    logger.warn({ chatId: input.chatId, raw: raw.slice(0, 120) }, 'heart parse failed, fail-closed pass');
    return { act: 'pass', path: 'chat', why: 'parse_failed', latencyMs, judgeResult: toJudgeResult('pass', 'chat', latencyMs) };
  }

  logger.info(
    { chatId: input.chatId, act: parsed.act, path: parsed.path, why: parsed.why, latencyMs },
    'Heart decision',
  );
  return { ...parsed, latencyMs, judgeResult: toJudgeResult(parsed.act, parsed.path, latencyMs) };
}

export { parseHeart };
