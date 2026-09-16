// ────────────────────────────────────────
// Expression approval gate (self-learning, automated)
//
// Before a learned situation→style pattern is allowed to inject into the system
// prompt, an automated quality check approves/rejects it — preventing learned-style
// drift (the bot picking up off-persona, toxic, or incoherent habits). This is the
// automated stand-in for astrbot_plugin_self_learning's human WebUI review gate.
// ────────────────────────────────────────

import { callWithFallback } from '../ai/fallback.js';
import { logger } from '../shared/logger.js';
import {
  chatsWithPendingExpressions, getPendingExpressions, setExpressionStatus,
} from './expression-learner.js';

const GATE_BATCH = 12;          // tunable — patterns reviewed per LLM call
const APPROVE_THRESHOLD = 0.5;  // tunable — min confidence to approve

const log = logger.child({ mod: 'expression-gate' });

interface GateVerdict { idx: number; approve: boolean; confidence: number }

/** Parse the gate LLM's JSON verdict array. Robust to fences/prose. */
export function parseGateVerdicts(raw: string): GateVerdict[] {
  try {
    const cleaned = raw.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
    const m = cleaned.match(/\[[\s\S]*\]/);
    const arr = JSON.parse(m ? m[0] : cleaned) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr
      .map((x) => x as Record<string, unknown>)
      .filter((x) => typeof x.idx === 'number')
      .map((x) => ({
        idx: x.idx as number,
        approve: x.approve === true || x.approve === 'true',
        confidence: typeof x.confidence === 'number' ? x.confidence : (x.approve ? 0.7 : 0.3),
      }));
  } catch {
    return [];
  }
}

/** Review a single chat's pending expressions. Returns {approved, rejected}. */
export async function reviewChatExpressions(chatId: number): Promise<{ approved: number; rejected: number }> {
  const pending = getPendingExpressions(chatId, GATE_BATCH);
  if (pending.length === 0) return { approved: 0, rejected: 0 };

  const listing = pending.map((p, i) => `${i}. 场景「${p.situation}」→ 风格「${p.style}」`).join('\n');
  const system =
    '你是一个"学习质量把关器"。机器人是个轻松可爱的猫娘群友，它从群聊里学到了一些"在某场景下用某种说话风格"的模式。' +
    '判断每条学到的模式是否值得纳入它的说话习惯：要求——符合轻松、可爱、口语化的猫娘群友人设；连贯、有意义；不低俗、不冒犯、不阴阳怪气、不像广告或复读。' +
    '只输出JSON数组，每条对应一个编号：[{"idx":0,"approve":true,"confidence":0.0-1.0}]';
  const user = `学到的模式：\n${listing}\n\n逐条判断是否采纳：`;

  try {
    const result = await callWithFallback({
      usage: 'judge',
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      maxTokens: 400,
      temperature: 0,
    });
    const verdicts = parseGateVerdicts(result.content);
    let approved = 0, rejected = 0;
    for (const v of verdicts) {
      const p = pending[v.idx];
      if (!p) continue;
      const ok = v.approve && v.confidence >= APPROVE_THRESHOLD;
      setExpressionStatus(chatId, p.situation, p.style, ok ? 'approved' : 'rejected', v.confidence);
      if (ok) approved++; else rejected++;
    }
    // Any pending the model didn't address stay pending for the next pass.
    log.info({ chatId, approved, rejected }, 'Expression gate reviewed');
    return { approved, rejected };
  } catch (err) {
    log.debug({ err, chatId }, 'reviewChatExpressions failed (non-critical)');
    return { approved: 0, rejected: 0 };
  }
}

/** Cron entry: review pending expressions across all chats. Returns total reviewed. */
export async function runExpressionGate(): Promise<number> {
  let total = 0;
  for (const chatId of chatsWithPendingExpressions()) {
    const { approved, rejected } = await reviewChatExpressions(chatId);
    total += approved + rejected;
  }
  return total;
}
