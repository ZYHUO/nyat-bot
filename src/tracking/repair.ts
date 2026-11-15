// Relationship repair: noticing that something went wrong and going back to fix it.
//
// WHY THIS EXISTS
//
// `action-board.ts` already defines a `repair` action kind with a priority weight
// and a capability requirement, and `tracking/outcome.ts` already detects the
// triggering signals (`explicit_negative`, `repair_loop`) and records them as the
// `corrected` outcome on the bot's own acts. But nothing ever consumed that
// signal to actually attempt a repair — the action existed with no producer.
//
// A person who realises they said something wrong goes back and says so. That is
// one of the most human things there is, and it is precisely what a bot that
// "never acknowledges mistakes" fails to do.
//
// WHAT THIS IS NOT
//
// Not an auto-apology. Apologising on a timer or on every negative signal reads
// as servile and hollow — the opposite of a person. This module only SURFACES
// the situation ("this went badly, you may want to go back to it") and lets the
// model decide whether to, and how. The host never sends anything itself.

import { getDb } from '../db/sqlite.js';
import { logger } from '../shared/logger.js';
import { env } from '../env.js';

export interface UnrepairedAct {
  botMessageId: number;
  /** The bot's own line that landed badly. */
  said: string;
  /** What kind of negative signal it got. */
  kind: 'corrected' | 'rejected';
  at: number;
  minutesAgo: number;
}

/** How far back to look for an unrepaired act. */
const LOOKBACK_SEC = 45 * 60;
const MAX_PREVIEW = 60;
/** One repair offer per act — after this, let it go rather than nagging. */
const MAX_OFFERS = 3;

function inline(value: string, max: number): string {
  return value.replace(/[\r\n]+/g, ' ').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, max);
}

/**
 * Acts of the bot's that landed badly and have not been revisited since.
 *
 * "Revisited" = a later bot message in the same chat. That is deliberately loose:
 * the point is to notice "I said something, it went badly, and I never came back
 * to it", not to grade the quality of any follow-up.
 */
export function findUnrepairedActs(chatId: number, now = Math.floor(Date.now() / 1000)): UnrepairedAct[] {
  if (!env().REPAIR_ENABLED) return [];
  if (!Number.isSafeInteger(chatId) || chatId === 0) return [];
  try {
    const db = getDb();
    const since = now - LOOKBACK_SEC;
    const rows = db.prepare(
      `SELECT bot_message_id, ts, reply_text, outcome
       FROM self_replies
       WHERE chat_id = ? AND ts >= ? AND outcome IN ('corrected')
       ORDER BY ts DESC LIMIT 5`,
    ).all(chatId, since) as Array<{
      bot_message_id: number | null;
      ts: number;
      reply_text: string;
      outcome: string;
    }>;
    if (rows.length === 0) return [];

    // Has the bot spoken since? If so it already had a chance to smooth things
    // over and this module stays out of it.
    const newest = db.prepare(
      `SELECT MAX(ts) AS t FROM self_replies WHERE chat_id = ?`,
    ).get(chatId) as { t: number | null } | undefined;
    const lastSpoke = newest?.t ?? 0;

    const out: UnrepairedAct[] = [];
    for (const row of rows) {
      if (!row.bot_message_id) continue;
      // Only surface acts the bot never followed up on.
      if (lastSpoke > row.ts) continue;
      out.push({
        botMessageId: row.bot_message_id,
        said: inline(row.reply_text, MAX_PREVIEW),
        kind: 'corrected',
        at: row.ts,
        minutesAgo: Math.max(1, Math.round((now - row.ts) / 60)),
      });
      if (out.length >= MAX_OFFERS) break;
    }
    return out;
  } catch (err) {
    logger.debug({ err, chatId }, 'findUnrepairedActs failed (non-critical)');
    return [];
  }
}

/**
 * Render unrepaired acts as a fact block.
 *
 * Facts and an opening, not an instruction: it tells the model what happened and
 * leaves the choice entirely to it. A person is not obliged to apologise — they
 * are obliged to have noticed.
 */
export function renderUnrepairedActs(acts: UnrepairedAct[]): string {
  if (acts.length === 0) return '';
  const lines = ['[有件事可能没说好]'];
  for (const act of acts) {
    lines.push(`  ${act.minutesAgo} 分钟前你说「${act.said}」，对方的反应不太好，之后你没再提。`);
  }
  lines.push('（要不要回去说点什么，你自己看——不一定要道歉，也可以解释、也可以就当过去了。）');
  return lines.join('\n');
}
