// ────────────────────────────────────────
// 定型判断基座 — 把小判断从"问聊天模型再解析散文"里救出来
// ────────────────────────────────────────
//
// 为什么要它：bot 每天 45M token 里，绝大多数花在"换回一个小决定"——
// gate 三选一（1806 次）、heart 说/等/不说（8789 次）、shadow（1904 次）、
// judge（布尔）。每一次都要把一大坨 prompt 重发给一个会说话的模型，再解析它的散文。
// 而 TypeSafe System One (Jev) 这类模型的契约是"问一个定型问题，返回带概率的定型
// 答案"，实测 ~330 in / 23 out。code 拥有流程，模型只提供那一点语义常识。
//
// 三条设计底线（都是生产事故换来的）：
//   1. **fail-open**：任何后端故障都返回 ok:false，调用方自行决定放行。绝不让一次
//      判断失败吞掉用户一句话。
//   2. **隐私分级**：DM（chatId>0）与 private 内容默认**不走外部判断服务**，
//      只走 bot 既有的 LLM 链（visibility 层不是为了好看的）。
//   3. **可插拔**：typesafe 是当前主后端，chat 是兜底。今天换供应商只动一个文件，
//      任何调用点都没有硬外部依赖。
//
// 成本统一走 llmEvents 总线 → metrics/token-ledger 落 llm_token_daily，
// 这样"换后端省了多少"是财报，不是感觉。

import { env } from '../env.js';
import { callWithFallback } from './fallback.js';
import { llmEvents } from './events.js';
import { logger } from '../shared/logger.js';
import { createHash } from 'node:crypto';

export type JudgmentKind = 'noul' | 'choice' | 'score';

export interface JudgmentSpec {
  kind: JudgmentKind;
  /** 问题本体（instructions）。要短、要封闭，别把背景重复一遍——背景在 state 里。 */
  question: string;
  /** choice：选项 key → 人话描述 */
  options?: Record<string, string>;
  /** score：**有序** 的描述刻度（低 → 高） */
  levels?: readonly string[];
}

export interface JudgmentAnswer {
  kind: JudgmentKind;
  /** noul → P(yes)；choice → 选中的选项 key；score → 刻度上的数值 */
  value: number | string;
  /** 该答案本身的概率（choice = 选中项概率；score = 最高档概率） */
  probability: number | null;
  confidence: number | null;
}

export interface JudgmentBatch {
  /** 缓存身份：调用方自定的稳定 key（同一判断重复问会命中缓存） */
  key: string;
  /** 背景：只放这个判断需要的信息，别把整个对话历史倒进来稀释判定 */
  state: string;
  questions: Record<string, JudgmentSpec>;
  chatId?: number;
  visibility?: 'private' | 'contextual' | 'public';
  timeoutMs?: number;
}

export interface JudgmentResult {
  /** 实际走的后端；'cache' 表示命中缓存未发起调用 */
  backend: 'typesafe' | 'chat' | 'cache';
  ok: boolean;
  answers: Record<string, JudgmentAnswer | null>;
}

// ── 缓存 ────────────────────────────────────────────────────────────
interface CacheEntry { at: number; result: { answers: Record<string, JudgmentAnswer | null> } }
const _cache = new Map<string, CacheEntry>();

function cacheKeyOf(b: JudgmentBatch): string {
  const h = createHash('sha1');
  h.update(b.key);
  h.update('\x00');
  h.update(b.state);
  h.update('\x00');
  h.update(JSON.stringify(b.questions));
  return h.digest('hex');
}

// ── 熔断 ────────────────────────────────────────────────────────────
let _consecutiveFails = 0;
let _openUntilMs = 0;

function breakerAllows(): boolean {
  return Date.now() >= _openUntilMs;
}
function noteSuccess(): void {
  _consecutiveFails = 0;
}
function noteFailure(): void {
  _consecutiveFails += 1;
  const e = env();
  if (_consecutiveFails >= e.JUDGE_SUBSTRATE_BREAKER_FAILS) {
    _openUntilMs = Date.now() + e.JUDGE_SUBSTRATE_BREAKER_COOLDOWN_MS;
    _consecutiveFails = 0;
    logger.warn({ cooldownMs: e.JUDGE_SUBSTRATE_BREAKER_COOLDOWN_MS }, 'judge substrate: typesafe breaker OPEN → chat fallback');
  }
}

/** DM / private 内容不走外部判断服务（只走 bot 既有 LLM 链）。 */
function mustStayInternal(chatId?: number, visibility?: string): boolean {
  if (chatId !== undefined && chatId > 0) return true;
  return visibility === 'private';
}

// ── 后端 A：TypeSafe System One ─────────────────────────────────────
async function askTypesafe(b: JudgmentBatch): Promise<Record<string, JudgmentAnswer | null> | null> {
  const e = env();
  if (!e.TYPESAFE_API_KEY) return null;
  const questions: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(b.questions)) {
    if (spec.kind === 'choice') questions[name] = { type: 'choice', instructions: spec.question, ...(spec.options ? { criteria: spec.options } : {}) };
    else if (spec.kind === 'score') questions[name] = { type: 'score', instructions: spec.question, ...(spec.levels ? { criteria: [...spec.levels] } : {}) };
    else questions[name] = { type: 'noul', instructions: spec.question };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), b.timeoutMs ?? e.JUDGE_SUBSTRATE_TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await fetch(e.TYPESAFE_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${e.TYPESAFE_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: b.state, model: e.TYPESAFE_MODEL, questions }),
      signal: controller.signal,
    });
    if (!res.ok) {
      emitTokens('judgment', 'typesafe', started, 0, 0);
      return null;
    }
    const data = (await res.json()) as {
      answers?: Record<string, {
        noul?: number; choice?: string; score?: number; confidence?: number;
        probabilities?: Record<string, number>;
      }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    emitTokens('judgment', 'typesafe', started, data.usage?.input_tokens ?? 0, data.usage?.output_tokens ?? 0);
    const answers = data.answers;
    if (!answers) return null;

    const out: Record<string, JudgmentAnswer | null> = {};
    for (const [name, spec] of Object.entries(b.questions)) {
      const a = answers[name];
      if (!a) { out[name] = null; continue; }
      if (spec.kind === 'noul' && typeof a.noul === 'number') {
        out[name] = { kind: 'noul', value: a.noul, probability: a.noul, confidence: a.confidence ?? null };
      } else if (spec.kind === 'choice' && typeof a.choice === 'string') {
        out[name] = {
          kind: 'choice',
          value: a.choice,
          probability: a.probabilities?.[a.choice] ?? null,
          confidence: a.confidence ?? null,
        };
      } else if (spec.kind === 'score' && typeof a.score === 'number') {
        const probs = a.probabilities ? Object.values(a.probabilities) : [];
        out[name] = {
          kind: 'score',
          value: a.score,
          probability: probs.length > 0 ? Math.max(...probs) : null,
          confidence: a.confidence ?? null,
        };
      } else {
        out[name] = null;
      }
    }
    return out;
  } catch {
    emitTokens('judgment', 'typesafe', started, 0, 0);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function emitTokens(usage: string, label: string, startedMs: number, prompt: number, completion: number): void {
  try {
    llmEvents.emit('result', {
      usage, label, model: label, outcome: 'ok',
      latencyMs: Date.now() - startedMs,
      promptTokens: prompt, completionTokens: completion, cachedTokens: 0,
    });
  } catch { /* telemetry never breaks a judgment */ }
}

// ── 后端 B：既有 chat LLM + JSON 兜底 ───────────────────────────────
async function askChat(b: JudgmentBatch): Promise<Record<string, JudgmentAnswer | null> | null> {
  const lines: string[] = [];
  for (const [name, spec] of Object.entries(b.questions)) {
    if (spec.kind === 'noul') lines.push(`- ${name}: 回答 0 到 1 之间的数，表示"${spec.question}"这件事为真的概率`);
    else if (spec.kind === 'choice') {
      const opts = spec.options ? Object.entries(spec.options).map(([k, v]) => `${k}=${v}`).join('; ') : '自由选择';
      lines.push(`- ${name}: ${spec.question}。从这些里选一个：${opts}。只输出选项 key`);
    } else {
      const lv = spec.levels ?? [];
      lines.push(`- ${name}: ${spec.question}。刻度 0 到 ${Math.max(0, lv.length - 1)}（${lv.join(' < ')}）。输出一个数`);
    }
  }
  const prompt =
    '你是判断器，不是聊天助手。只输出 JSON，不要任何解释。\n' +
    `背景：\n${b.state}\n\n请对下面每一项给出判断：\n${lines.join('\n')}\n\n` +
    '输出形如 {"<名字>": {"value": <数字或选项key>}} 的 JSON。';
  try {
    const r = await callWithFallback({
      usage: 'judge',
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 200,
      temperature: 0,
    });
    const parsed = JSON.parse((r.content ?? '').replace(/^```(?:json)?|```$/g, '').trim()) as Record<string, { value?: unknown }>;
    const out: Record<string, JudgmentAnswer | null> = {};
    for (const [name, spec] of Object.entries(b.questions)) {
      const v = parsed?.[name]?.value;
      if (spec.kind === 'choice' && typeof v === 'string') out[name] = { kind: 'choice', value: v, probability: null, confidence: null };
      else if (spec.kind !== 'choice' && typeof v === 'number') out[name] = { kind: spec.kind, value: v, probability: v, confidence: null };
      else out[name] = null;
    }
    return out;
  } catch {
    return null;
  }
}

// ── 主入口 ──────────────────────────────────────────────────────────
export async function judge(b: JudgmentBatch): Promise<JudgmentResult> {
  const empty = (backend: 'typesafe' | 'chat' | 'cache'): JudgmentResult => ({
    backend,
    ok: false,
    answers: Object.fromEntries(Object.keys(b.questions).map((k) => [k, null])),
  });

  const ck = cacheKeyOf(b);
  const ttl = env().JUDGE_SUBSTRATE_CACHE_TTL_MS;
  if (ttl > 0) {
    const hit = _cache.get(ck);
    if (hit && Date.now() - hit.at <= ttl) {
      return { backend: 'cache', ok: true, answers: hit.result.answers };
    }
  }

  const useTypesafe =
    env().JUDGE_SUBSTRATE_ENABLED &&
    env().JUDGE_SUBSTRATE_BACKEND === 'typesafe' &&
    !mustStayInternal(b.chatId, b.visibility) &&
    breakerAllows();

  if (useTypesafe) {
    const answers = await askTypesafe(b);
    if (answers !== null) {
      noteSuccess();
      if (ttl > 0) _cache.set(ck, { at: Date.now(), result: { answers } });
      return { backend: 'typesafe', ok: true, answers };
    }
    noteFailure();
    logger.debug({ key: b.key }, 'judge substrate: typesafe unavailable, falling back to chat');
  }

  const chatAnswers = await askChat(b);
  if (chatAnswers === null) return empty('chat');
  if (ttl > 0) _cache.set(ck, { at: Date.now(), result: { answers: chatAnswers } });
  return { backend: 'chat', ok: true, answers: chatAnswers };
}

/** 测试/运维用：清缓存与熔断状态。 */
export function resetJudgmentState(): void {
  _cache.clear();
  _consecutiveFails = 0;
  _openUntilMs = 0;
}
