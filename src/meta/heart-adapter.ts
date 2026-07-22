// Meta-path Heart gate: passive (non-L0) messages ask Heart whether to speak,
// then elevate to Attention for Meta/CodeAct. Direct/@ still skip Heart.

import type { FormattedMessage } from '../shared/types.js';
import { env } from '../env.js';
import { logger } from '../shared/logger.js';
import { getBotDisplayName, getBotUid } from '../bot/bot.js';
import { heartDecision } from '../pipeline/heart/decision.js';
import { composeSelfState } from '../pipeline/heart/self-state.js';
import { computeEngagement, HARD_PASS_BUDGET } from '../pipeline/heart/engagement.js';
import {
  getChatState,
  getGateCooldownRemainingMs,
  isInContinuation,
  transitionToWait,
} from '../pipeline/timing/chat-runtime.js';
import { recordGateNoAction } from '../pipeline/timing/state-store.js';
import type { AttentionLayer } from './types.js';
import { getRedis } from '../db/redis.js';

export type MetaHeartVerdict = 'allow' | 'silence';

export interface MetaHeartResult {
  verdict: MetaHeartVerdict;
  /** Layer to ingest when allow (always L1 for heart-elevated). */
  layer: AttentionLayer;
  reason: string;
  pressureBoost?: number;
  path?: 'chat' | 'lookup';
}

function waitAnchorKey(chatId: number): string {
  return `xxb:meta:wait-anchor:${chatId}`;
}

/**
 * Heart decide for Meta ingress. Call only for non-direct / non-L0 group messages.
 * - reply → allow as L1 (reason heart:…) so Meta gap-fill can dispatch
 * - wait → Meta wait-anchor + silence (resume re-ingests)
 * - pass / budget / cooldown → silence
 */
export async function evaluateMetaHeart(opts: {
  chatId: number;
  formatted: FormattedMessage;
  layer: AttentionLayer;
}): Promise<MetaHeartResult> {
  const e = env();
  const { chatId, formatted, layer } = opts;

  if (!e.HEART_ENABLED) {
    // No Heart: preserve prior Meta policy (L2 drop handled by caller).
    if (layer === 'L2') {
      return { verdict: 'silence', layer, reason: 'heart_off_l2' };
    }
    return { verdict: 'allow', layer, reason: 'heart_off' };
  }

  if (chatId > 0) {
    return { verdict: 'allow', layer: 'L0', reason: 'dm' };
  }

  // One Heart chime-in per refractory window: CodeAct busy, prior Heart arm,
  // or lastBotReplyAt (group pile-on / 连珠炮). Arm covers parallel Heart LLMs
  // that finish after the first elevate but before CodeAct speaks.
  try {
    const { shouldSuppressMetaHeartElevate } = await import('./heart-refractory.js');
    if (await shouldSuppressMetaHeartElevate(chatId)) {
      const { isCodeActBusy } = await import('../subagent/task-store.js');
      const busy = await isCodeActBusy(chatId).catch(() => false);
      const reason = busy ? 'heart_busy' : 'heart_refractory';
      logger.info({ chatId, messageId: formatted.messageId, reason }, 'Meta heart: suppress silence');
      return { verdict: 'silence', layer, reason };
    }
  } catch {
    /* fail-open */
  }

  let recentMessages: FormattedMessage[] = [];
  try {
    const { getRecent } = await import('../pipeline/context/manager.js');
    recentMessages = await getRecent(chatId, 40);
  } catch {
    recentMessages = [formatted];
  }

  const botUid = getBotUid() || 0;
  const nowSec = Math.floor(Date.now() / 1000);
  const messagesLast5Min = recentMessages.filter((m) => nowSec - (m.timestamp || 0) < 300).length;

  let tstate;
  try {
    tstate = await getChatState(chatId);
  } catch {
    tstate = undefined;
  }

  const continuation = tstate !== undefined && isInContinuation(tstate);

  if (!continuation) {
    try {
      const cool = await getGateCooldownRemainingMs(chatId, tstate);
      if (cool > 0) {
        logger.info({ chatId, cool, messageId: formatted.messageId }, 'Meta heart: cooldown silence');
        return { verdict: 'silence', layer, reason: 'heart_cooldown' };
      }
    } catch {
      /* fail-open to heart */
    }

    const engagement = computeEngagement(recentMessages, botUid, messagesLast5Min);
    if (engagement.budget <= HARD_PASS_BUDGET) {
      logger.info(
        {
          chatId,
          budget: engagement.budget.toFixed(2),
          factors: engagement.factors,
          messageId: formatted.messageId,
        },
        'Meta heart: engagement hard-pass',
      );
      return { verdict: 'silence', layer, reason: 'heart_engagement' };
    }
  }

  const selfState = await composeSelfState(chatId);
  let lastSpokeSecAgo: number | undefined;
  if (tstate?.lastBotReplyAt) {
    lastSpokeSecAgo = (Date.now() - tstate.lastBotReplyAt) / 1000;
  }

  const engagementNote = continuation
    ? undefined
    : computeEngagement(recentMessages, botUid, messagesLast5Min).note ?? undefined;

  const heart = await heartDecision({
    chatId,
    message: formatted,
    recentMessages,
    botUid,
    botName: getBotDisplayName(),
    selfState,
    lastSpokeSecAgo,
    burstNote: engagementNote,
  });

  void import('../pipeline/heart/mind.js')
    .then(({ noteThought }) => noteThought(chatId, heart.why))
    .catch(() => {});

  if (heart.act === 'wait') {
    const waitSec = Math.max(e.TIMING_WAIT_MIN_SEC, 8);
    try {
      await getRedis().set(
        waitAnchorKey(chatId),
        JSON.stringify({
          chatId,
          layer: 'L1',
          reason: `heart:${heart.why || 'wait'}`,
          messageId: formatted.messageId,
          userId: formatted.uid,
          textPreview: (formatted.textContent || '').slice(0, 200),
          pressure: 70,
          createdAt: Date.now(),
          payload: {
            username: formatted.username || undefined,
            fullName: formatted.fullName || undefined,
            heartPath: heart.path,
            ...(formatted.replyTo
              ? {
                  replyTo: {
                    messageId: formatted.replyTo.messageId,
                    uid: formatted.replyTo.uid,
                    fullName: formatted.replyTo.fullName,
                    textSnippet: (formatted.replyTo.textSnippet ?? '').slice(0, 200),
                  },
                }
              : {}),
          },
        }),
        'EX',
        waitSec + 120,
      );
      await transitionToWait(chatId, waitSec, formatted.messageId, formatted.uid);
    } catch (err) {
      // Prefer silence over half-armed wait (anchor without WAIT state → duplicate resume).
      logger.warn({ err, chatId }, 'Meta heart wait setup failed — silence');
      return { verdict: 'silence', layer: 'L1', reason: 'heart_wait_setup_failed' };
    }
    logger.info({ chatId, why: heart.why, waitSec, messageId: formatted.messageId }, 'Meta heart: wait');
    return { verdict: 'silence', layer: 'L1', reason: `heart_wait:${heart.why}` };
  }

  if (heart.act === 'pass') {
    try {
      await recordGateNoAction(chatId, formatted.uid);
    } catch {
      /* non-critical */
    }
    logger.info(
      { chatId, why: heart.why, messageId: formatted.messageId, latencyMs: heart.latencyMs },
      'Meta heart: pass',
    );
    return { verdict: 'silence', layer, reason: `heart_pass:${heart.why}` };
  }

  // reply — NX arm so only one parallel Heart elevate wins; losers silence.
  try {
    const { armMetaHeartRefractory } = await import('./heart-refractory.js');
    if (!(await armMetaHeartRefractory(chatId))) {
      logger.info(
        { chatId, messageId: formatted.messageId },
        'Meta heart: lost arm race — silence',
      );
      return { verdict: 'silence', layer: 'L1', reason: 'heart_refractory' };
    }
  } catch {
    /* non-critical */
  }
  logger.info(
    {
      chatId,
      why: heart.why,
      path: heart.path,
      messageId: formatted.messageId,
      latencyMs: heart.latencyMs,
    },
    'Meta heart: reply → Attention',
  );
  return {
    verdict: 'allow',
    layer: 'L1',
    reason: `heart:${heart.why || 'reply'}`,
    pressureBoost: heart.path === 'lookup' ? 25 : 15,
    path: heart.path,
  };
}
