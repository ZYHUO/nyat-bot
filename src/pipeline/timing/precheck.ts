// Deterministic pre-check for the timing gate.
//
// WHY THIS EXISTS
//
// Measured 2026-09-18 against production logs: the gate's LLM branch produced
// `no_action` in **121 of 122** decisions, with a highly homogeneous set of
// reasons ("未提及我，话题无关，不硬挤" / "群友正聊…未被@…保持安静" / …). Tracing
// those back to the prompt, they all matched one explicit rule in
// `prompts/task/timing-gate.md`:
//
//   「群友们彼此在聊、不是在跟我聊 → no_action，别硬挤。」
//
// So the LLM was matching a rule, at ~2.2s and one API call per decision.
//
// This module answers that same question deterministically. It is deliberately
// CONSERVATIVE: it only short-circuits when the structural facts are
// unambiguous, and defers to the LLM in every other case. Getting this wrong in
// the permissive direction costs an LLM call; getting it wrong in the
// restrictive direction silently drops a reply the bot should have sent — so
// the bar for returning a verdict is high.
//
// NOT a replacement for the gate's judgement: it covers the one case that is
// decidable from structure alone (nobody is addressing the bot, and the humans
// are talking to each other).

import type { FormattedMessage } from '../../shared/types.js';
import { isMentioningSelf } from '../judge/rules.js';

export interface PreCheckInput {
  message: FormattedMessage;
  recentMessages: FormattedMessage[];
  botUid: number;
  botUsername: string;
  botNicknames: string[];
  /** True when the gate was invoked in proactive mode (bot inserting itself). */
  proactiveMode?: boolean;
}

/**
 * `true` when the message is structurally a human-to-human turn that does not
 * involve the bot at all, so the gate would certainly answer `no_action`.
 *
 * Requires ALL of:
 *   1. not proactive mode (in proactive mode, "nobody addressed me" is expected
 *      and the gate's whole job is to judge whether to insert anyway)
 *   2. the trigger does not mention the bot by @username or nickname
 *   3. the trigger is not a reply to the bot
 *   4. the trigger is from a human (not another bot, not the bot itself)
 *   5. the trigger is a normal text message (not a command)
 *   6. the recent window contains at least one human-to-human exchange, i.e.
 *      another human message that replies to or mentions a third party — the
 *      structural signature of "群友们彼此在聊"
 *
 * Condition 6 is what keeps this from being a blanket "unaddressed → silent"
 * rule: a lone message with no addressee structure at all still goes to the LLM,
 * because that is exactly the ambiguous case the gate exists for.
 */
export function isClearlyHumanToHuman(input: PreCheckInput): boolean {
  if (input.proactiveMode) return false;

  const msg = input.message;
  if (msg.isBot || msg.role === 'assistant') return false;

  const text = (msg.textContent || msg.captionContent || '').trim();
  if (!text) return false;
  // Commands are addressed to whichever bot owns them; leave those to the gate.
  if (text.startsWith('/')) return false;

  if (isMentioningSelf(text, input.botUsername, input.botNicknames)) return false;
  if (msg.replyTo?.uid === input.botUid) return false;

  // Structural evidence that humans are talking among themselves: at least one
  // other human message in the window that is addressed to a third party.
  const others = input.recentMessages.filter(
    (m) => m.messageId !== msg.messageId && !m.isBot && m.role !== 'assistant' && m.uid !== input.botUid,
  );
  const humanToHuman = others.some((m) => {
    if (m.replyTo?.uid && m.replyTo.uid !== input.botUid && m.replyTo.uid !== m.uid) return true;
    const t = (m.textContent || m.captionContent || '');
    // An @handle that is not the bot.
    const handles = t.match(/@([A-Za-z][A-Za-z0-9_]{3,})/g) ?? [];
    return handles.some((h) => h.slice(1).toLowerCase() !== input.botUsername.toLowerCase());
  });

  return humanToHuman;
}
