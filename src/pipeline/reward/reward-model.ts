// ────────────────────────────────────────
// Proactive willingness gate ("reward model")
//
// Ported from thunlp/ProactiveAgent's predict→validate→emit: before the bot
// volunteers an UNSOLICITED message (proactive scan / idle poke), a cheap LLM
// judge scores whether saying *this specific thing right now* actually fits —
// the #1 failure mode of proactive bots is interrupting / talking when unwanted.
// This replaces a flat probability with a content-aware decision.
//
// Fail-OPEN: on timeout/error the message is allowed (we never want a gate
// outage to silence the bot). The value is in the rejections it makes when it
// works. Single-shot (no retry) to keep cost ~one judge call.
// ────────────────────────────────────────

import { callWithFallback } from '../../ai/fallback.js';
import { getRedis } from '../../db/redis.js';
import { logger } from '../../shared/logger.js';
import { slimContextForAI } from '../context/slim.js';
import { getBotUid } from '../../bot/bot.js';
import type { FormattedMessage } from '../../shared/types.js';

const REWARD_GATE_ENABLED = true;     // tunable
const REWARD_GATE_TIMEOUT_MS = 6000;  // tunable
const REWARD_GATE_CONTEXT_MSGS = 12;  // tunable — how many recent msgs the judge sees

export interface RewardVerdict {
  accept: boolean;
  reasoning: string;
}

const log = logger.child({ mod: 'reward-gate' });

/** Parse the judge's JSON verdict. Defaults to accept on anything unparseable. */
export function parseRewardResponse(raw: string): RewardVerdict {
  try {
    const cleaned = raw.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
    const m = cleaned.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(m ? m[0] : cleaned) as { accept?: unknown; judgement?: unknown; reasoning?: unknown };
    const j = typeof parsed.judgement === 'string' ? parsed.judgement.toLowerCase() : '';
    const accept = parsed.accept === false || j === 'rejected' || j === 'reject'
      ? false
      : parsed.accept === true || j === 'accepted' || j === 'accept' ? true : true;
    return { accept, reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '' };
  } catch {
    return { accept: true, reasoning: 'unparseable→fail-open' };
  }
}

/**
 * Decide whether a proposed proactive utterance should be sent right now.
 * @param recent       recent group messages (context)
 * @param proposedText the message the bot wants to send
 * @param kind         'proactive' | 'idle' (for logging)
 */
export async function runRewardGate(
  chatId: number,
  recent: FormattedMessage[],
  proposedText: string,
  kind: 'proactive' | 'idle' = 'proactive',
): Promise<RewardVerdict> {
  if (!REWARD_GATE_ENABLED || !proposedText.trim()) {
    return { accept: true, reasoning: 'disabled' };
  }

  const last = recent[recent.length - 1] ?? ({ messageId: 0, uid: 0 } as FormattedMessage);
  const ctx = recent.length > 0
    ? slimContextForAI(recent.slice(-REWARD_GATE_CONTEXT_MSGS), last, getBotUid())
    : '(无最近消息)';

  const system =
    '你是一个"主动发言把关器"。机器人是群里的一个普通成员，它想在没人点名的情况下主动说一句话。' +
    '你的任务：判断"现在发这句话"是否合适——是否会显得突兀、打断、刷存在感、答非所问、或在严肃/私密话题里乱插嘴。' +
    '原则：减少打扰。融入当前话题、能自然接话、群里气氛轻松时倾向通过；冷场硬聊、和上下文无关、重复啰嗦、或别人正在认真交流时倾向拒绝。' +
    '只输出JSON：{"accept": true|false, "reasoning": "一句话理由"}';
  const user = `最近群聊：\n${ctx}\n\n机器人想主动发的话：「${proposedText}」\n\n现在发合适吗？`;

  try {
    const result = await Promise.race([
      callWithFallback({
        usage: 'judge',
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        maxTokens: 120,
        temperature: 0,
      }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), REWARD_GATE_TIMEOUT_MS)),
    ]);

    if (!result) {
      log.debug({ chatId, kind }, 'Reward gate timed out → fail-open accept');
      return { accept: true, reasoning: 'timeout→fail-open' };
    }

    const verdict = parseRewardResponse(result.content);
    log.info({ chatId, kind, accept: verdict.accept, reasoning: verdict.reasoning.slice(0, 80) }, 'Reward gate verdict');
    // Lightweight metric: remember the last verdict per chat
    getRedis().set(`xxb:reward:last:${chatId}`, JSON.stringify({ accept: verdict.accept, ts: Math.floor(Date.now() / 1000), kind }), 'EX', 86400).catch(() => {});
    return verdict;
  } catch (err) {
    log.debug({ err, chatId, kind }, 'Reward gate failed → fail-open accept');
    return { accept: true, reasoning: 'error→fail-open' };
  }
}
