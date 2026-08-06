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
import { isCallerAbort } from '../../shared/abort.js';
import { AIError } from '../../shared/errors.js';
import { slimContextForAI } from '../context/slim.js';
import { loadCachedPrompt } from '../../shared/config.js';
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

function summarizeHeartRaw(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return 'empty';
  const cleaned = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  if (!/[{}]/.test(cleaned)) return `non_json:${cleaned.slice(0, 60)}`;
  return `jsonish:${cleaned.slice(0, 60)}`;
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
    confidence: 1,
    latencyMs,
  };
}

/**
 * 心流判断。永不 throw:LLM 失败 → fail-closed pass(被动消息少接一条
 * 比误抢话安全;直接交互根本不经过这里)。
 */
export async function heartDecision(input: HeartInput): Promise<HeartDecision> {
  const d = await _heartDecision(input);
  // G8 A/B 基线:三种出口各自的次数。记在这里而不是调用方 —— 本函数有 5 条
  // 提前返回的失败路径(prompt_load_failed / llm_failed / parse_failed …)和
  // 两个调用方(pipeline.ts、meta/heart-adapter.ts),在出口收口才不会漏。
  // 抛出的情况(caller abort)不记:那不是一次"决策"。
  void import('../../metrics/social-ledger.js')
    .then(({ recordDecision }) => recordDecision(input.chatId, d.act))
    .catch(() => { /* telemetry never breaks the decision path */ });
  return d;
}

async function _heartDecision(input: HeartInput): Promise<HeartDecision> {
  const start = performance.now();
  const e = env();

  let systemPrompt: string;
  try {
    let personaCore = '';
    try {
      // 身份/识人守则(主人 uid、"绝不管别人叫主人")是心流硬依赖。
      // 参与节奏在 behavior-style.md（从 persona 拆出）；拼在身份段后面。
      const full = loadCachedPrompt('identity/persona.md');
      // 旧版曾有「我在群里的样子」大段——若还在则截掉，避免和 behavior-style 重复。
      const legacyCut = full.indexOf('## 我在群里的样子');
      const identity = legacyCut > 0
        ? full.slice(0, legacyCut).trimEnd()
        : full.trimEnd();
      let style = '';
      try { style = loadCachedPrompt('identity/behavior-style.md').trim(); } catch { /* optional */ }
      personaCore = style ? `${identity}\n\n${style}` : identity;
      if (personaCore.length > 2400) personaCore = personaCore.slice(0, 2400);
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
      // stepfun 这类中文小模型吐脏 JSON(单引号 / Python dict / markdown 围栏)不算罕见,
      // 而 parseHeart 失败会把**整份** prompt(heart.md + persona core + 群聊上下文)重发
      // 一遍。provider 已支持 jsonMode(provider.ts:197),heart 的两次调用原先都没传 ——
      // heart 是全系统调用频次最高的 LLM,这一行的杠杆很高。
      jsonMode: true,
      chatId: input.chatId,
      usage: 'judge',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMsg },
      ],
      // maxTokens 不再硬编码(callWithFallback 里显式参数会压过 usage 配置):
      // 推理模型思考先烧 token 会截断成空 → rejectEmpty → fail-closed。
      // 上限由 AI_USAGE_JUDGE_MAX_TOKENS 管理（heart 已并入 judge）。
      temperature: 0,
      rejectEmpty: true,
      // 只传原始打断信号。8s 预算改为 per-attempt cap(maxTimeoutMs):
      // 旧写法把 AbortSignal.timeout 烧进共享 signal,主标签一旦超时,
      // 所有 backup 的合并信号天生已 aborted → 心流在慢主模型下没有任何
      // 可用 fallback,fail-closed pass = 静默吞回复。
      // 代价:最坏 attempts × 8s 串行(hedge/cooldown 通常会短路)。
      signal: input.signal,
      maxTimeoutMs: e.TIMING_GATE_TIMEOUT_MS,
    });
    raw = result.content;
  } catch (err) {
    // 调用方打断(turn 新消息/关机)≠ LLM 故障:上抛交给 actor 走『等静默期+
    // 带新上下文重规划』。若 fail-closed pass 吞掉,既丢了本该 replan 的回合,
    // 又把正常打断刷成 warn(实测占当前进程最大 warn 来源)。
    if (isCallerAbort(input.signal) || (err instanceof AIError && err.code === 'AI_ABORTED')) {
      throw err;
    }
    const latencyMs = Math.round(performance.now() - start);
    logger.warn({ err, chatId: input.chatId }, 'heart LLM failed, fail-closed pass');
    return { act: 'pass', path: 'chat', why: 'llm_failed', latencyMs, judgeResult: toJudgeResult('pass', 'chat', latencyMs) };
  }

  let parsed = parseHeart(raw);
  if ((!parsed || !raw.trim()) && !input.signal?.aborted) {
    try {
      const retry = await callWithFallback({
      // stepfun 这类中文小模型吐脏 JSON(单引号 / Python dict / markdown 围栏)不算罕见,
      // 而 parseHeart 失败会把**整份** prompt(heart.md + persona core + 群聊上下文)重发
      // 一遍。provider 已支持 jsonMode(provider.ts:197),heart 的两次调用原先都没传 ——
      // heart 是全系统调用频次最高的 LLM,这一行的杠杆很高。
      jsonMode: true,
        chatId: input.chatId,
        usage: 'judge',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMsg },
          { role: 'assistant', content: raw.slice(0, 300) },
          { role: 'user', content: '上面的输出为空或不是合法 JSON。只输出一个非空 JSON 对象，字段必须只有 act/path/why。act 只能是 reply/wait/pass。' },
        ],
        temperature: 0,
        rejectEmpty: true,
        signal: input.signal,
        maxTimeoutMs: e.TIMING_GATE_TIMEOUT_MS,
      });
      raw = retry.content;
      parsed = parseHeart(raw);
    } catch (err) {
      if (isCallerAbort(input.signal) || (err instanceof AIError && err.code === 'AI_ABORTED')) {
        throw err;
      }
      logger.debug({ err, chatId: input.chatId }, 'heart parse-retry failed');
    }
  }
  const latencyMs = Math.round(performance.now() - start);
  if (!parsed) {
    logger.warn({ chatId: input.chatId, rawSummary: summarizeHeartRaw(raw) }, 'heart parse failed, fail-closed pass');
    return { act: 'pass', path: 'chat', why: 'parse_failed', latencyMs, judgeResult: toJudgeResult('pass', 'chat', latencyMs) };
  }

  // 心流反思(默认关):只在决定 reply 时,用同一个 heart 模型把「念头」再磨一遍——
  // 不改决策(act/path 不动)、不换模型,只让流给写手的 [你的念头] 更抓重点。
  // 只在 reply 轮加这一次调用;失败/空/超时/打断一律保底用原念头(fail-safe)。
  if (parsed.act === 'reply' && e.HEART_REFLECT_ENABLED && !input.signal?.aborted) {
    try {
      const rr = await callWithFallback({
        // 念头磨光走 summarize（原 heart_reflect 已并入）
        usage: 'summarize',
        messages: [
          {
            role: 'system',
            content:
              `你是${input.botName}。你刚决定接下面 ★ 那条消息,当前念头是「${parsed.why}」。` +
              `再想半秒:这念头抓到点子了吗?会不会太笼统、没接到重点、或跟你刚说过的重复?` +
              `给一句**更利落、更抓重点**的念头(≤30字,是你想说话的方向/切入点,不是回复原文)。只输出这一句。`,
          },
          { role: 'user', content: `[群聊上下文]\n${ctxStr}\n\n★ 就是你要接的那条。` },
        ],
        temperature: 0.3,
        rejectEmpty: true,
        signal: input.signal,
        // 反思模型是 dsv4flash(轻思考,~5-6s),放宽到 10s;超了就放弃、用原念头。
        maxTimeoutMs: 10_000,
      });
      const refined = (rr.content || '').trim().replace(/^[「"'"]+|[」"'"]+$/g, '').slice(0, 60);
      if (refined.length >= 2) {
        logger.info({ chatId: input.chatId, from: parsed.why, to: refined }, 'Heart reflect refined 念头');
        parsed = { ...parsed, why: refined };
      }
    } catch (err) {
      if (isCallerAbort(input.signal) || (err instanceof AIError && err.code === 'AI_ABORTED')) throw err;
      logger.debug({ err, chatId: input.chatId }, 'heart reflect failed (kept original why)');
    }
  }

  logger.info(
    { chatId: input.chatId, act: parsed.act, path: parsed.path, why: parsed.why, latencyMs },
    'Heart decision',
  );
  return { ...parsed, latencyMs, judgeResult: toJudgeResult(parsed.act, parsed.path, latencyMs) };
}

export { parseHeart };
