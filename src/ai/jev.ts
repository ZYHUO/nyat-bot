// ────────────────────────────────────────
// Jev 客户端 — TypeSafe System One 结构化判断(Choice / Score / Noul)
// ────────────────────────────────────────
//
// 定位:**帮 LLM 少花时间做“定型判断”**,不是又一个会写散文的聊天模型。
// System One 模型的契约:问一个封闭问题,返回带概率的定型答案(不生成文本)。
// 一次调用可带多个彼此独立的问题(speculative fan-out);code 拥有流程,
// 模型只补那一点语义常识。
//
// 请求/响应形状(2026-09-22 对 lfree relay 实测,不是照抄官方 SDK):
//   POST {JEV_BASE_URL}/v1/systemone
//     { state, model, questions: { ID: { type, instructions, criteria } } }
//     criteria: choice → { key: 描述 };score → [低..高] 的有序刻度;noul → 不带
//   → 200 { answers: { ID: <answer> }, usage:{input_tokens,output_tokens} }
//     noul   → { type:'noul',   noul:<p(yes)> }               (无独立 confidence)
//     choice → { type:'choice', choice:<key>, confidence:<0-1>, probabilities:{...} }
//     score  → { type:'score',  score:<0-indexed float>, confidence:<0-1>, legend:{i:描述}, probabilities:{...} }
//   注:这条 relay 的 jev-1.13 **不走** /v1/chat/completions(那会 503 没有 channel),
//       唯一入口就是 /v1/systemone。别把 Jev 塞进任何 OpenAI chat 抽象里。
//
// 三条设计底线(沿用 src/ai/judge-substrate.ts 的生产教训):
//   1. **fail-open**:任何故障/超时/乱码/低置信一律返回 null,调用方**必须**有不依赖
//      它的降级路径(绝大多数调用点 = 退回原来的 callWithFallback LLM 那条路)。
//      绝不让一次判断失败把用户一句话吞了。
//   2. **隐私分级**:DM(chatId>0)与 private 内容不送外部判断服务(visibility 层不是摆设)。
//   3. **可整体关掉 + 熔断**:JEV_ENABLED 默认 false;relay 假死后前几条消息最多各等
//      一次超时,熔断期间直接降级,不每条消息都干等。
//
// 与 judge-substrate 的关系:那个打**官方** api.typesafe.ai(TYPESAFE_*,jev-latest)
// 服务两个异步校验;这个打**另一条 relay**(JEV_*,jev-1.13),同构但端点不同,
// 故意分开配置、分开开关。改一条 relay 不该动另一条。

import { env } from '../env.js';
import { logger } from '../shared/logger.js';
import { incrCounter } from '../metrics/registry.js';

export type JevKind = 'noul' | 'choice' | 'score';

export interface JevNoulQuestion { type: 'noul'; instructions: string; }
export interface JevChoiceQuestion { type: 'choice'; instructions: string; /** 选项 key → 人话描述 */ criteria: Record<string, string>; }
export interface JevScoreQuestion { type: 'score'; instructions: string; /** 有序刻度(低→高) */ criteria: readonly string[]; }
export type JevQuestion = JevNoulQuestion | JevChoiceQuestion | JevScoreQuestion;

export interface JevNoulAnswer { type: 'noul'; /** P(yes) */ probability: number; }
export interface JevChoiceAnswer { type: 'choice'; choice: string; confidence: number; probability: number | null; }
export interface JevScoreAnswer { type: 'score'; /** 0-indexed 刻度上的(可为小数)分值 */ score: number; confidence: number; }
export type JevAnswer = JevNoulAnswer | JevChoiceAnswer | JevScoreAnswer;

export interface JevRequest {
  /** 只放这个判断需要的信息,别把整段对话历史倒进来稀释判定。 */
  state: string;
  questions: Record<string, JevQuestion>;
  timeoutMs?: number;
  chatId?: number;
  visibility?: string;
}

/** relay 原始 answer(宽类型,入参前逐字段校验)。 */
interface RawAnswer {
  type?: string;
  noul?: number;
  choice?: string;
  score?: number;
  confidence?: number;
  probabilities?: Record<string, number>;
}

// ── 熔断:连续失败 N 次后开路一段时间,期间零网络直接降级 ──────────────────
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
  if (_consecutiveFails >= e.JEV_BREAKER_FAILS) {
    _openUntilMs = Date.now() + e.JEV_BREAKER_COOLDOWN_MS;
    _consecutiveFails = 0;
    logger.warn({ cooldownMs: e.JEV_BREAKER_COOLDOWN_MS }, 'jev: breaker OPEN → callers fall back');
  }
}

function buildQuestions(questions: Record<string, JevQuestion>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [id, spec] of Object.entries(questions)) {
    if (spec.type === 'choice') out[id] = { type: 'choice', instructions: spec.instructions, criteria: spec.criteria };
    else if (spec.type === 'score') out[id] = { type: 'score', instructions: spec.instructions, criteria: [...spec.criteria] };
    else out[id] = { type: 'noul', instructions: spec.instructions };
  }
  return out;
}

function parseAnswer(spec: JevQuestion, a: RawAnswer | undefined): JevAnswer | null {
  if (!a) return null;
  if (spec.type === 'noul') {
    return typeof a.noul === 'number' && Number.isFinite(a.noul) ? { type: 'noul', probability: a.noul } : null;
  }
  if (spec.type === 'choice') {
    if (typeof a.choice !== 'string') return null;
    // relay 只在给出过的选项里挑;真挑了集合外的(乱码/漂移)视作不可用,别信。
    if (!Object.prototype.hasOwnProperty.call(spec.criteria, a.choice)) return null;
    const p = a.probabilities?.[a.choice];
    return {
      type: 'choice',
      choice: a.choice,
      confidence: typeof a.confidence === 'number' ? a.confidence : 0,
      probability: typeof p === 'number' ? p : null,
    };
  }
  // score
  return typeof a.score === 'number' && Number.isFinite(a.score)
    ? { type: 'score', score: a.score, confidence: typeof a.confidence === 'number' ? a.confidence : 0 }
    : null;
}

/**
 * 一次 systemone 调用。**永不抛**:任何不该继续的情形都返回 null(带计数/日志),
 * 返回值形态是 `{ [问题ID]: JevAnswer }`;某个问题解析不出来时那个 ID 不出现。
 * 调用方据此决定“用它 / 降级”。全问题不可用也返回 null(视作一次失败,记熔断)。
 */
export async function callJev(req: JevRequest): Promise<Record<string, JevAnswer> | null> {
  const e = env();
  const skip = (outcome: string): null => {
    incrCounter('jev_calls_total', { outcome });
    return null;
  };
  if (!e.JEV_ENABLED) return skip('disabled');
  if (!e.JEV_BASE_URL || !e.JEV_API_KEY) {
    logger.debug({ model: e.JEV_MODEL }, 'jev: base url / api key 未配置,跳过');
    return skip('unconfigured');
  }
  // DM / private 内容不走外部判断服务。
  if (req.chatId !== undefined && req.chatId > 0) return skip('dm_skipped');
  if (req.visibility === 'private') return skip('private_skipped');
  const ids = Object.keys(req.questions);
  if (ids.length === 0) return skip('empty');
  if (!breakerAllows()) return skip('breaker_open');

  const url = `${e.JEV_BASE_URL.replace(/\/+$/, '')}/v1/systemone`;
  const timeoutMs = req.timeoutMs ?? e.JEV_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${e.JEV_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: req.state, model: e.JEV_MODEL, questions: buildQuestions(req.questions) }),
      signal: controller.signal,
    });
    const latencyMs = Math.round(performance.now() - started);
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 200);
      noteFailure();
      logger.warn({ status: res.status, body, latencyMs }, 'jev: http error → 调用方降级');
      incrCounter('jev_calls_total', { outcome: 'http_error' });
      return null;
    }
    const data = (await res.json().catch(() => null)) as {
      answers?: Record<string, RawAnswer>;
      usage?: { input_tokens?: number; output_tokens?: number };
    } | null;
    const answersRaw = data?.answers;
    if (!answersRaw || typeof answersRaw !== 'object') {
      noteFailure();
      logger.warn({ latencyMs }, 'jev: 响应无 answers → 调用方降级');
      incrCounter('jev_calls_total', { outcome: 'bad_response' });
      return null;
    }

    const parsed: Record<string, JevAnswer> = {};
    let anyNull = false;
    for (const id of ids) {
      const a = parseAnswer(req.questions[id]!, answersRaw[id]);
      if (a === null) { anyNull = true; continue; }
      parsed[id] = a;
    }
    if (Object.keys(parsed).length === 0) {
      noteFailure();
      logger.warn({ latencyMs, ids }, 'jev: 无一条可解析 → 调用方降级');
      incrCounter('jev_calls_total', { outcome: 'unparseable' });
      return null;
    }
    if (anyNull) logger.debug({ latencyMs, ids }, 'jev: 部分问题不可解析(返回其余)');

    noteSuccess();
    const inTok = data!.usage?.input_tokens ?? 0;
    const outTok = data!.usage?.output_tokens ?? 0;
    logger.info({ latencyMs, ids, in: inTok, out: outTok }, 'jev: ok');
    incrCounter('jev_calls_total', { outcome: 'ok' });
    if (inTok) incrCounter('jev_input_tokens_total', {}, inTok);
    if (outTok) incrCounter('jev_output_tokens_total', {}, outTok);
    return parsed;
  } catch (err) {
    const latencyMs = Math.round(performance.now() - started);
    noteFailure();
    const msg = err instanceof Error ? err.message.slice(0, 160) : String(err);
    logger.warn({ err: msg, latencyMs }, 'jev: 请求失败(超时/网络) → 调用方降级');
    incrCounter('jev_calls_total', { outcome: 'exception' });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface JevChoiceOpts { id: string; state: string; question: string; criteria: Record<string, string>; timeoutMs?: number; chatId?: number; visibility?: string; }
export async function callJevChoice(o: JevChoiceOpts): Promise<JevChoiceAnswer | null> {
  const r = await callJev({ state: o.state, timeoutMs: o.timeoutMs, chatId: o.chatId, visibility: o.visibility, questions: { [o.id]: { type: 'choice', instructions: o.question, criteria: o.criteria } } });
  const a = r?.[o.id];
  return a && a.type === 'choice' ? a : null;
}

export interface JevNoulOpts { id: string; state: string; question: string; timeoutMs?: number; chatId?: number; visibility?: string; }
export async function callJevNoul(o: JevNoulOpts): Promise<JevNoulAnswer | null> {
  const r = await callJev({ state: o.state, timeoutMs: o.timeoutMs, chatId: o.chatId, visibility: o.visibility, questions: { [o.id]: { type: 'noul', instructions: o.question } } });
  const a = r?.[o.id];
  return a && a.type === 'noul' ? a : null;
}

export interface JevScoreOpts { id: string; state: string; question: string; levels: readonly string[]; timeoutMs?: number; chatId?: number; visibility?: string; }
export async function callJevScore(o: JevScoreOpts): Promise<JevScoreAnswer | null> {
  const r = await callJev({ state: o.state, timeoutMs: o.timeoutMs, chatId: o.chatId, visibility: o.visibility, questions: { [o.id]: { type: 'score', instructions: o.question, criteria: [...o.levels] } } });
  const a = r?.[o.id];
  return a && a.type === 'score' ? a : null;
}

/** 测试/运维用:清熔断状态。 */
export function resetJevState(): void {
  _consecutiveFails = 0;
  _openUntilMs = 0;
}
