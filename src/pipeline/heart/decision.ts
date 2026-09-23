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
import { normalizeReactionEmoji } from '../reply/reaction-emoji.js';
import { answeredTimestamps } from '../../meta/answered.js';
import { incrCounter } from '../../metrics/registry.js';
import { getReflection } from '../../tracking/outcome.js';
import { isMentioningSelf } from '../judge/rules.js';
import { getBotIdentity } from '../../bot/bot.js';
import type { SelfState } from './self-state.js';

export type HeartAct = 'reply' | 'wait' | 'pass' | 'react';

export interface HeartDecision {
  act: HeartAct;
  /** act=reply 时:chat(直说)/ lookup(需要查资料 → planned 路径) */
  path: 'chat' | 'lookup';
  why: string;
  latencyMs: number;
  /** round 8：act=react 时模型挑的 emoji（已过白名单校验）；其余 act 为 undefined。 */
  emoji?: string;
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
  /** Optional bounded scoped workspace block for the V2 rollout. */
  cognitiveWorkspaceHint?: string;
  /**
   * Concrete facts about the bot's own recent behaviour in this chat.
   * Rendered by src/agent/self-history.ts; empty when there is nothing to show.
   * This is what lets the model notice it is over-participating — the host does
   * not decide that for it.
   */
  selfHistory?: string;
  signal?: AbortSignal;
}

/**
 * 这条消息是不是**直接叫 bot**（@username / 昵称 / 回复 bot / 私聊）。
 *
 * 与 precheck.ts 的 isClearlyHumanToHuman 同一套判据，但反过来用：
 * 那个问"是不是 clearly 人与人之间聊"，这个问"是不是 clearly 在叫我"。
 */
export function isAddressedToBot(
  message: FormattedMessage,
  botUid: number,
): boolean {
  if (botUid > 0 && message.replyTo?.uid === botUid) return true;
  const text = (message.textContent || message.captionContent || '').trim();
  if (!text) return false;
  try {
    const id = getBotIdentity();
    if (isMentioningSelf(text, id.username, id.nicknames)) return true;
  } catch {
    // bot 未初始化（测试/探针）时退回 botName 包含匹配
  }
  return false;
}

/**
 * 心流 LLM 失败时的**保句闸**（2026-09-21 新增的前置功能）。
 *
 * 实测：`heart LLM failed, fail-closed pass` 在日志里出现 1867 次，
 * 占全部心流裁决（7443 次）的 **25%**。失败原因 64% 是 "All labels exhausted"
 * （整条 fallback 链死透），其余是超时/限流/内容审查。
 *
 * 旧行为一律 `pass` —— **消息被永久丢弃**。对没人叫 bot 的群聊消息这没毛病
 * （本来就不一定该接），但对**直接叫到 bot** 的那句是另一回事：
 * 有人 @ 了本喵问一件事，因为基础设施故障，这句话就此消失，对方永远等不到回复。
 * 这和"无视直接提问是另一种失败"是同一条原则——只是失败方从模型变成了线路。
 *
 * 所以：LLM 判不了时，**被直接叫到的消息转 wait（稍后重评），不转 pass（丢弃）**。
 * 没被叫到的仍旧 pass，避免线路故障时把整群闲聊都排成重试。
 *
 * `HEART_LLM_FAIL_KEEP_ADDRESSED` 门控，默认开。关则完全回到旧行为。
 */
function llmFailedDecision(
  input: HeartInput,
  latencyMs: number,
): HeartDecision {
  let act: HeartAct = 'pass';
  let why = 'llm_failed';
  if (env().HEART_LLM_FAIL_KEEP_ADDRESSED && isAddressedToBot(input.message, input.botUid)) {
    act = 'wait';
    why = 'llm_failed_keep_addressed';
    incrCounter('heart_llm_fail_keep_addressed_total', { chat: input.chatId });
    logger.warn(
      { chatId: input.chatId, messageId: input.message.messageId },
      'heart LLM failed — 被直接叫到，转 wait 保句（不丢弃）',
    );
  }
  return { act, path: 'chat', why, latencyMs, judgeResult: toJudgeResult(act, 'chat', latencyMs) };
}

/**
 * 清洗心流的 `why`——它会被原样注入写手的 prompt 当"念头"。
 *
 * 2026-09-23（新 goal，用户："前言不搭后语"）。实测 10,807 条 Heart decision：
 *
 *   why 含 `{`   926 条（9%）
 *   why 被截断    164 条（2%）
 *
 * 那些 why 长这样：
 *
 *   {doro发的众筹澳门家宽，倍率还行，要参吗？
 *   {刚撩猫羽就发男铜贴纸，这反差绷不住
 *
 * 模型有时在 why 里塞引用链/嵌套 JSON 片段（它把 `→回复 某人(#22222)`
 * 这类上下文记号当成了自己输出的一部分）。原样收下再截到 40 字，
 * 这条断裂的 JSON 片段就会被注入：
 *
 *   reply.ts:623  [你的念头] 你看到这条消息时心里想的是:「{doro发的众筹…」。
 *
 * 写手拿到一个坏念头，还被要求"顺着这个念头说，别另起炉灶"——
 * 于是它接得莫名其妙。**9% 的回复带着坏念头开笔。**
 *
 * 清洗规则（保守，只去明显是机器残留的部分，不动人话）：
 *   · 去掉首尾的 `{` `}` `[` `]` `"` `'` 和空白
 *   · 去掉尾部被截断的 JSON 尾巴（`…`、`,`、`："`、未闭合的引号）
 *   · 全部清完还为空 -> 返回 ''（调用方据此决定不注入）
 */
function cleanWhy(raw: string): string {
  let t = String(raw ?? '').trim();
  if (!t) return '';
  // 首尾的括号/引号/空白（模型把 JSON 结构也写进了 why）
  t = t.replace(/^[\s{}[\]"'`]+/, '').replace(/[\s{}[\]"'`]+$/, '');
  // 尾部截断的 JSON 残留：`…","path":"cha` 这种——在第一个 `","x":"` 处切断，
  // 只留人的那部分。（round 58 实测的是"散文 + 首尾括号"，
  // 这里是同一家族的另一种：整段 JSON 被塞进 why 后截断。）
  const cut = t.search(/["']\s*,\s*["'][\w-]+["']\s*:/);
  if (cut > 0) t = t.slice(0, cut);
  t = t.replace(/[,，:：、\s]+$/, '').trim();
  // 未闭合的引号（截断在字符串中段）
  if ((t.match(/"/g)?.length ?? 0) % 2 === 1) t = t.replace(/["']?[^"']*$/, '').trim();
  return t.slice(0, 40);
}

function parseHeart(raw: string): { act: HeartAct; path: 'chat' | 'lookup'; why: string } | null {
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const obj = JSON.parse(m[0]) as Record<string, unknown>;
    const act = String(obj['act'] ?? '').toLowerCase();
    if (act !== 'reply' && act !== 'wait' && act !== 'pass' && act !== 'react') return null;
    const pathRaw = String(obj['path'] ?? 'chat').toLowerCase();
    // round 8（新 goal）：react 带一个 emoji 字段。模型自己选表情，
    // 但只接受 Telegram 允许的那一小组（见 reaction-emoji.ts 的说明——
    // ❤ 是 U+2764 不带变体选择符，直接让模型写很容易写错）。
    // 不在集合里的回落到 null，由调用方随机挑。
    const emojiRaw = String(obj['emoji'] ?? '');
    const emoji = normalizeReactionEmoji(emojiRaw);
    return {
      act: act as HeartAct,
      path: pathRaw === 'lookup' ? 'lookup' : 'chat',
      why: cleanWhy(String(obj['why'] ?? '')),
      ...(act === 'react' ? { emoji } : {}),
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
    // 反馈学习闭环:outcome 追踪学到的「哪些该接/哪些不该接」规则,过去只注入
    // 回复写手(reply.ts),决定**接不接**的心流反而看不到 —— 学了个寂寞。
    // 这里把心流也接上:规则来自本群真实回复反馈(outcome.ts 蒸馏),空则整块塌陷。
    let learnedRules = '';
    if (e.OUTCOME_TRACKING_ENABLED) {
      try {
        const r = getReflection(input.chatId)?.trim();
        if (r) {
          learnedRules = `## 你之前在这个群学到的经验教训(来自真实回复反馈,优先遵守)\n\n${r}\n\n`;
          incrCounter('heart_learned_rules_injected_total', { chat: input.chatId });
        }
      } catch { /* non-critical */ }
    }
    systemPrompt = loadCachedPrompt('task/heart.md')
      .replace(/\{bot_name\}/g, input.botName)
      .replace(/\{persona_core\}/g, personaCore || `${input.botName} 是群聊里的猫娘成员`)
      .replace(/\{self_state\}/g, input.selfState.narration)
      .replace(/\{learned_rules\}/g, learnedRules);
  } catch (err) {
    logger.warn({ err }, 'heart prompt load failed, fail-closed pass');
    const latencyMs = Math.round(performance.now() - start);
    return { act: 'pass', path: 'chat', why: 'prompt_load_failed', latencyMs, judgeResult: toJudgeResult('pass', 'chat', latencyMs) };
  }

  const ctxStr = slimContextForAI(input.recentMessages, input.message, input.botUid);
  const presence = input.lastSpokeSecAgo !== undefined && input.lastSpokeSecAgo < 180
    ? `\n(你 ${Math.round(input.lastSpokeSecAgo)} 秒前刚在这个群说过话,正处于对话中)`
    : '';
  // The model's own recent behaviour, as facts. Placed right before the decision
  // so it is in view when judging; the older daily rules stay in the system
  // prompt. Both are needed: rules say "what generally works", this says
  // "what I just did".
  const selfHistoryBlock = input.selfHistory?.trim()
    ? `\n\n${input.selfHistory.trim().slice(0, 900)}`
    : '';
  const burstLine = input.burstNote ? `\n${input.burstNote}` : '';
  const workspaceLine = input.cognitiveWorkspaceHint?.trim()
    ? `\n\n${input.cognitiveWorkspaceHint.trim().slice(0, 3000)}`
    : '';
  // round 4（新 goal，用户："重复回复的概率太高了"）：
  // **★ 这条消息你自己是不是已经回过？** —— 当成事实告诉心流。
  //
  // 全量日志实测（40,083 条入站 / 4,808 个首气泡）：
  //   同一个锚点被回复 >1 次          153 个（占唯一锚点 7.9%）
  //   多出来的回复                    206 个 → 真实重复率 4.3%
  //   最严重的 8 个锚点各被回 5-6 次（"有完没完喵" / "本喵看不到图细节" ×3 变体）
  //
  // `markMessageAnswered` 全仓有 6 处调用（发出去就记），但**读它的人里没有
  // 心流**——attention.ts 只用它跳过"入队"，meta-api/session 用它防别的事，
  // 没有一处在"要不要回"之前问一句"我回过没有"。于是 bot 可以对同一条消息
  // 反复开口,而每次都以为自己是第一次接。
  //
  // 这里补上。**是陈述事实,不是禁令**——有时候同一条追加了新内容确实值得再回
  // （"那你觉得呢"跟在"在吗"后面）。把已经回过的次数和间隔给它看,
  // 让"又想接一遍"这个念头撞上事实。收不收看它自己。
  const nowSec = Math.floor(Date.now() / 1000);
  const answeredTimes = await answeredTimestamps(input.chatId, input.message.messageId);
  const answeredLine = answeredTimes.length
    ? `\n[这条你已经回过 ${answeredTimes.length} 次] 最近一次 ${Math.max(1, Math.round((nowSec - answeredTimes[0]!) / 60))} 分钟前。${
        answeredTimes.length >= 2
          ? '**连着接同一条,群里看着像复读机**——要么说点真正新的,要么让它过去。'
          : '除非人家追加了新内容,否则再回一遍就是在重复自己。'}`
    : '';

  const userMsg = `[群聊上下文]\n${ctxStr}${presence}${selfHistoryBlock}${burstLine}${workspaceLine}${answeredLine}\n\n对 ★ 标记的最新消息做出你的决定,输出 JSON。`;

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
    return llmFailedDecision(input, latencyMs);
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
    // H0 hybrid fail-soft:parse 失败 ≠ 没听懂。旧行为 fail-closed pass 直接吞回复,
    // 与 llm_failed 的 defer/judge 兜底不对称 —— 同一条消息因"吐脏 JSON"还是
    // "链路挂了"走不同命运。parse_failed 进同一条 hybrid 路径:defer 预算内重评,
    // 预算耗尽回退 legacy judge(与 llm_failed 同链,同日志前缀)。
    logger.warn({ chatId: input.chatId, rawSummary: summarizeHeartRaw(raw) }, 'heart parse failed, hybrid fallback');
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
        // 反思模型是 newapiv4pro(轻思考,~2-6s),放宽到 10s;超了就放弃、用原念头。
        maxTimeoutMs: 10_000,
      });
      // round 164：**refined 也要过 cleanWhy。** 之前这里只剥「」引号，
      // 不剥 {}[]——反射模型回 JSON 残片时，覆写后的 why 就带着前导 `{`。
      // 实测 09-21/22/23 三天 dirty why 532/352/211 条，全是这条路径漏的
      // （parseHeart 里的 cleanWhy 在覆写之前就跑完了）。
      // 而 why 会注入 [你的念头] 给写手——这里脏了，下游拿到的是垃圾方向。
      const refined = cleanWhy((rr.content || '').trim()).slice(0, 60);
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
