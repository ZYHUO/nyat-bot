// Meta-path Heart gate: passive messages ask whether to speak. Opt-in QQ
// addressed batches also ask which response fits, retaining direct priority
// when Heart chooses text. Other direct interactions keep their existing route.

import type { FormattedMessage } from '../shared/types.js';
import { env } from '../env.js';
import { assertInputBatchCurrent } from './pending-intent.js';
import { logger } from '../shared/logger.js';
import { getBotDisplayName, getBotUid } from '../bot/bot.js';
import { heartDecision } from '../pipeline/heart/decision.js';
import { composeSelfState } from '../pipeline/heart/self-state.js';
import {
  computeEngagement,
  HARD_PASS_BUDGET,
  isBotMonologueTrail,
  type Engagement,
} from '../pipeline/heart/engagement.js';
import {
  getChatState,
  getGateCooldownRemainingMs,
  isInContinuation,
  transitionToWait,
} from '../pipeline/timing/chat-runtime.js';
import { recordGateNoAction } from '../pipeline/timing/state-store.js';
import type { AttentionLayer } from './types.js';
import { dispatchWaitViaAgency } from '../agent/agency-wait-dispatch.js';
import { getSelfActSummary, renderSelfActSummary } from '../tracking/self-history.js';
import { nextSelfWake, renderPendingWake } from '../agent/cognitive-clock.js';
import { findUnrepairedActs, renderUnrepairedActs } from '../tracking/repair.js';
import { incrCounter } from '../metrics/registry.js';
import { isPlatformInternalId } from '../platform/identity-store.js';
import { resolveBatchTargets } from './heart-targets.js';

export type MetaHeartVerdict = 'allow' | 'silence';

export interface MetaHeartResult {
  verdict: MetaHeartVerdict;
  /** Passive text elevates to L1; addressed QQ text retains L0 priority. */
  layer: AttentionLayer;
  reason: string;
  pressureBoost?: number;
  path?: 'chat' | 'lookup';
  targetMessageIds?: number[];
}

/**
 * Heart decision for passive or explicitly opted-in addressed QQ group input.
 * - reply → L1 for passive input, L0 for addressed QQ input (reason heart:…)
 * - wait → Meta wait-anchor + silence (expiry reconsiders)
 * - pass / budget / cooldown → silence
 */
export async function evaluateMetaHeart(opts: {
  chatId: number;
  formatted: FormattedMessage;
  layer: AttentionLayer;
  cognitiveAnchorEventId?: string;
  /** Authenticated QQ group addressing, including an earlier bubble in this batch. */
  addressed?: boolean;
  ongoingFollowup?: boolean;
  batchMessages?: FormattedMessage[];
  targetMessageIds?: readonly number[];
  /** Only the passive Telegram microbatch owner can persist a source-scoped WAIT. */
  telegramBatchWait?: {
    reconsidering: number[];
    recentMessages?: FormattedMessage[];
    onDecision: (action: 'reply' | 'wait' | 'react', selected: readonly number[], waitSec: number) => Promise<boolean>;
  };
  signal?: AbortSignal;
  /** Host-owned generation/revision fence, checked again after model work. */
  isCurrent?: () => Promise<boolean>;
  beforeEffect?: () => Promise<boolean>;
  /** Expiry is one reconsideration, never an indefinitely recurring timer. */
  waitResume?: boolean;
}): Promise<MetaHeartResult> {
  const e = env();
  const { chatId, formatted, layer } = opts;
  const addressed = !!opts.addressed && chatId < 0 && isPlatformInternalId(chatId);
  const current = async (): Promise<boolean> => {
    if (opts.signal?.aborted) return false;
    try { assertInputBatchCurrent(opts.batchMessages ?? [formatted]); }
    catch (error) {
      if (error instanceof Error && (error.message === 'pending_intent_changed' || error.message === 'pending_intent_recalled')) return false;
      throw error;
    }
    // Host callbacks distinguish known invalidation (false) from an unavailable
    // authority (throw); the durable batch owner handles the latter outcome.
    return !opts.isCurrent || await opts.isCurrent();
  };
  const beforeEffect = async (): Promise<boolean> => {
    if (!await current()) return false;
    return (!opts.beforeEffect || await opts.beforeEffect()) && await current();
  };
  if (opts.signal?.aborted) return { verdict: 'silence', layer, reason: 'heart_aborted' };
  if (!await current()) return { verdict: 'silence', layer, reason: 'heart_input_changed' };

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
    if (!addressed && await shouldSuppressMetaHeartElevate(chatId)) {
      const { isCodeActBusy } = await import('../subagent/task-store.js');
      const busy = await isCodeActBusy(chatId).catch(() => false);
      const reason = busy ? 'heart_busy' : 'heart_refractory';
      logger.info({ chatId, messageId: formatted.messageId, reason }, 'Meta heart: suppress silence');
      return { verdict: 'silence', layer, reason };
    }
  } catch {
    /* fail-open */
  }

  let recentMessages = opts.telegramBatchWait?.recentMessages;
  if (!recentMessages) {
    try {
      const { getRecent } = await import('../pipeline/context/manager.js');
      recentMessages = await getRecent(chatId, 40, formatted.messageThreadId);
    } catch {
      recentMessages = [formatted];
    }
  }

  const botUid = getBotUid(chatId) || 0;
  const nowSec = Math.floor(Date.now() / 1000);
  const messagesLast5Min = recentMessages.filter((m) => nowSec - (m.timestamp || 0) < 300).length;

  let engagement: Engagement | undefined;
  let tstate;
  try {
    tstate = await getChatState(chatId);
  } catch {
    tstate = undefined;
  }

  const continuation = tstate !== undefined && isInContinuation(tstate);

  // 自发言环：即便在 continuation 免检窗也硬拦（否则刚回完又对下一条被动消息连珠炮）。
  if (!addressed && isBotMonologueTrail(recentMessages, botUid, 8, formatted.messageId)) {
    logger.info(
      { chatId, messageId: formatted.messageId },
      'Meta heart: bot monologue trail — silence',
    );
    return { verdict: 'silence', layer, reason: 'heart_bot_monologue' };
  }

  let cooldownRemainingMs = 0;
  if (!continuation && !addressed) {
    try {
      cooldownRemainingMs = await getGateCooldownRemainingMs(chatId, tstate);
    } catch {
      /* fail-open to heart */
    }
    // HEART_COOLDOWN_AS_FACT: don't silently drop before the model has seen the
    // situation. The cooldown becomes a fact in the prompt ("你 N 秒前刚说过话
    // ——自己掂量") and the model decides. Silent dropping took the decision away
    // from the model AND made the later dispatch-gate check a second gate over a
    // decision that was never made. Off = legacy silent pass.
    if (cooldownRemainingMs > 0 && !e.HEART_COOLDOWN_AS_FACT) {
      logger.info({ chatId, cool: cooldownRemainingMs, messageId: formatted.messageId }, 'Meta heart: cooldown silence');
      return { verdict: 'silence', layer, reason: 'heart_cooldown' };
    }

    engagement = computeEngagement(recentMessages, botUid, messagesLast5Min);
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

  const cognitiveWorkspacePromise = e.COGNITIVE_WORKSPACE_V2_ENABLED
    ? (async () => {
      try {
        const { buildCognitiveWorkspace, renderCognitiveWorkspace } = await import('../agent/cognitive-workspace.js');
        const snapshot = await buildCognitiveWorkspace({
          chatId,
          ...(!formatted.isAnonymous && formatted.uid > 0 ? { userId: formatted.uid } : {}),
          queryText: (formatted.textContent || formatted.captionContent || '').slice(0, 800),
          asOfEventId: opts.cognitiveAnchorEventId,
        });
        return renderCognitiveWorkspace(snapshot, 2200);
      } catch (err) {
        logger.debug({ err, chatId }, 'Meta Heart cognitive workspace failed (non-critical)');
        return undefined;
      }
    })()
    : Promise.resolve(undefined);
  // The recorded event updates the projection before its read-only disposition
  // is composed; an old prompt snapshot must not lag one event behind.
  if (e.EMOTION_CONTINUITY_ENABLED) await cognitiveWorkspacePromise;
  const selfState = await composeSelfState(chatId, formatted.textContent || formatted.captionContent || '');
  const cognitiveWorkspaceHint = await cognitiveWorkspacePromise;
  let lastSpokeSecAgo: number | undefined;
  if (tstate?.lastBotReplyAt) {
    lastSpokeSecAgo = (Date.now() - tstate.lastBotReplyAt) / 1000;
  }

  // Reuse the engagement already computed above (identical args) instead of
  // recomputing — avoids a redundant pass over recentMessages.
  const engagementNote = continuation ? undefined : engagement?.note ?? undefined;

  // The model's own recent behaviour, as facts. Meta is the production main
  // path, so this must be wired here too — wiring only pipeline/heart would
  // leave the feature dead on the path that actually runs.
  // Rendering only: the host draws no conclusion, the model decides.
  let selfHistory: string | undefined;
  if (e.SELF_HISTORY_ENABLED) {
    try {
      // round 16：先取这个群自己的常态（7 天基线，Redis 缓存 6 小时），
      // 再和"这一波"的占比一起递给心流。没有基线就退回到绝对占比。
      const { getSelfShareBaseline, getSelfCadence } = await import('../tracking/self-history.js');
      const [baselineShare, cadencePerHour] = await Promise.all([
        getSelfShareBaseline(chatId).catch(() => undefined),
        // round 17：节奏。占比答"我是不是在自言自语"，节奏答"我是不是太吵"。
        // 实测那两个最吵的群占比只有 12%，占比门槛在它们身上永远不触发。
        getSelfCadence(chatId).catch(() => undefined),
      ]);
      const parts = [
        renderSelfActSummary(getSelfActSummary(chatId, e.SELF_HISTORY_WINDOW_MIN * 60, baselineShare, cadencePerHour)),
        // "when I said I'd think again" lives only in the event ledger.
        renderPendingWake(nextSelfWake({ visibility: 'chat', chatId })),
        // Acts that landed badly and were never revisited — the repair offer.
        renderUnrepairedActs(findUnrepairedActs(chatId)),
      ].filter(Boolean);
      selfHistory = parts.length ? parts.join('\n') : undefined;
    } catch { /* non-critical: history is an aid, never a gate */ }
  }

  if (!await current()) return { verdict: 'silence', layer, reason: 'heart_input_changed' };
  const heart = await heartDecision({
    chatId,
    message: formatted,
    recentMessages,
    batchMessages: opts.batchMessages,
    targetMessageIds: opts.targetMessageIds,
    reconsideringMessageIds: opts.telegramBatchWait?.reconsidering,
    botUid,
    botName: getBotDisplayName(chatId),
    selfState,
    addressed,
    ongoingFollowup: addressed && opts.ongoingFollowup,
    signal: opts.signal,
    lastSpokeSecAgo,
    cognitiveWorkspaceHint,
    ...(selfHistory ? { selfHistory } : {}),
    burstNote: [
      opts.batchMessages && opts.batchMessages.length > 1 && !opts.telegramBatchWait?.reconsidering.length
        ? `(同一会话刚连续收到 ${opts.batchMessages.length} 条消息，★ 是这批最后一句；结合整批内容做一次决定，不要只答第一句。)` : undefined,
      engagementNote,
      // The fact the dispatch gate used to act on. Handing it to the model here
      // is what makes HEART_COOLDOWN_AS_FACT / HEART_DECIDES_TIMING possible:
      // the model weighs it, instead of the host overriding it afterwards.
      cooldownRemainingMs > 0
        ? `(你 ${Math.round(cooldownRemainingMs / 1000)} 秒前刚说过话——不是不让你说,是你自己掂量现在接合不合适)`
        : undefined,
    ].filter(Boolean).join('\n') || undefined,
  });
  if (opts.signal?.aborted) return { verdict: 'silence', layer, reason: 'heart_aborted' };
  if (!await current()) return { verdict: 'silence', layer, reason: 'heart_input_changed' };
  if (isPlatformInternalId(chatId)) {
    const { isOneBotMessageRecalled } = await import('../platform/onebot-notices.js');
    if ((opts.batchMessages ?? [formatted]).some(message => isOneBotMessageRecalled(chatId, message.messageId))) {
      return { verdict: 'silence', layer, reason: 'heart_anchor_recalled' };
    }
  }

  void import('../pipeline/heart/mind.js')
    .then(({ noteThought }) => noteThought(chatId, heart.why))
    .catch(() => {});

  if (opts.telegramBatchWait && heart.act !== 'pass') {
    const selected = resolveBatchTargets(heart.act, opts.targetMessageIds ?? [], heart.targetMessageIds, formatted.messageId);
    if (!selected) return { verdict: 'silence', layer, reason: 'heart_batch_targets_invalid' };
    if (heart.act === 'wait' && !e.TIMING_GATE_ENABLED) return { verdict: 'silence', layer, reason: 'heart_wait_transport_unavailable' };
    const waitSec = Math.min(Math.max(8, e.TIMING_WAIT_MIN_SEC), e.TIMING_WAIT_MAX_SEC);
    if (!await opts.telegramBatchWait.onDecision(heart.act, selected, waitSec)) {
      return { verdict: 'silence', layer, reason: 'heart_batch_wait_not_scheduled' };
    }
    // A passive Telegram wait uses the existing candidate rows and claim. It
    // must not install a second Redis/Agency wake for the same source.
    if (heart.act === 'wait') return { verdict: 'silence', layer, reason: `heart_wait:${heart.why}` };
  }

  // round 54（新 goal）：**Meta 路径补上 act=react**。
  //
  // 今大量样本（n=596）里 react 第一次非零（9 次），而表情一个都没发出去。
  // 原因：`'Heart decision'` 日志唯一来源是 decision.ts，而调它的有两条路径——
  // heart.ts（pipeline，round 8 接了 react）和 heart-adapter.ts（**Meta，没接）。
  // Meta 只判 wait / pass，react 落到默认分支被静默丢掉。
  // 而 Meta 是生产主路径（group_chats_processed 105 vs legacy 7）——
  // 所以 round 8 说“机制已接”只接了一半。
  //
  // 和 round 4（只接读不接写）、round 19/26（只修 2 处漏 5 处）同形：
  // **改了 A 路径就宣布做完，而生产走 B。**
  if (heart.act === 'react') {
    const { pickReactionEmoji } = await import('../pipeline/reactions.js');
    const emoji = heart.emoji ?? pickReactionEmoji('neutral');
    let sent = false;
    let deliveryUnknown = false;
    if (emoji) {
      const { reactToMessage } = await import('../bot/sender/telegram.js');
      if (!await beforeEffect()) return { verdict: 'silence', layer, reason: 'heart_input_changed' };
      try {
        sent = await reactToMessage(chatId, formatted.messageId, emoji);
      } catch (err) {
        deliveryUnknown = !!err && typeof err === 'object' && 'delivery' in err && err.delivery === 'unknown';
        if (!isPlatformInternalId(chatId)) logger.debug({ err, chatId }, 'Meta heart reactToMessage failed');
      }
    }
    if (sent) {
      logger.info({ chatId, emoji, why: heart.why }, 'Meta heart: reacted');
      void import('../metrics/social-ledger.js')
        .then(({ recordDecision }) => recordDecision(chatId, 'react'))
        .catch(() => { /* telemetry never breaks */ });
      // react 是出口：副作用已做完，让 Meta 当成静默。
      return { verdict: 'silence', layer: 'L1', reason: `heart_react:${heart.why}` };
    }
    if (isPlatformInternalId(chatId) || opts.telegramBatchWait) {
      // A source-scoped reaction never authorizes text on the same question.
      // A timeout can mean the platform already received the reaction.
      // End this event without retry, text fallback, or a text refractory arm;
      // subsequent independent messages can ask Heart again normally.
      const reason = deliveryUnknown ? 'heart_react_unknown' : 'heart_react_undelivered';
      logger.warn({ chatId, messageId: formatted.messageId, reason }, 'Meta heart: reaction ended without text fallback');
      incrCounter(deliveryUnknown ? 'meta_react_unknown_total' : 'meta_react_undelivered_total', { chat: chatId });
      return { verdict: 'silence', layer: 'L1', reason };
    }
    // 发不出去（够不着的消息/权限）——别坐实“点过”。
    // 落到下面的 wait 分支让它继续被当条消息对待。
    // round 94：debug → warn + 计数。本会话第 5 处"防问题的机制只有 debug 日志"
    // （前四处：round 75 截断重试 / round 77 sticker pick / round 78 reflection /
    //   round 84 代发 guard / round 87 撞名守卫）。
    //
    // 它 0 次触发，但和"非法的 0"一样——debug 级下看不见，
    // 分不清"没发生"和"发生了但被过滤"。
    logger.warn({ chatId, emoji }, 'Meta heart: react not delivered, falling through');
    incrCounter('meta_react_undelivered_total', { chat: chatId });
  }
  if (heart.act === 'wait') {
    if (opts.waitResume) return { verdict: 'silence', layer, reason: 'heart_wait_expired_still_waiting' };
    if (!e.TIMING_GATE_ENABLED) return { verdict: 'silence', layer, reason: 'heart_wait_transport_unavailable' };
    const waitSec = Math.max(e.TIMING_WAIT_MIN_SEC, 8);
    const { setMetaWaitAnchor } = await import('./timing-adapter.js');
    if (!await beforeEffect()) return { verdict: 'silence', layer, reason: 'heart_input_changed' };
    try {
      const waitGeneration = await setMetaWaitAnchor({
          chatId,
          layer: addressed ? 'L0' : 'L1',
          reason: `heart:${heart.why || 'wait'}`,
          messageId: formatted.messageId,
          pendingIntent: formatted.pendingIntent, messageThreadId: formatted.messageThreadId,
          userId: formatted.uid,
          cognitiveAnchorEventId: opts.cognitiveAnchorEventId,
          textPreview: (formatted.textContent || '').slice(0, 200),
          pressure: 70,
          createdAt: Date.now(),
          heartMessages: opts.batchMessages ?? [formatted],
          addressed,
          ongoingFollowup: opts.ongoingFollowup,
          targetMessageIds: opts.targetMessageIds ? [...opts.targetMessageIds] : undefined,
          payload: {
            ...(opts.batchMessages && opts.batchMessages.length > 1 ? { qqBatch: opts.batchMessages.map(message => ({
              messageId: message.messageId, pendingIntent: message.pendingIntent, messageThreadId: message.messageThreadId, userId: message.uid, textPreview: (message.textContent || '').slice(0, 200),
              username: message.username, fullName: message.fullName,
              ...(message.replyTo ? { replyTo: { messageId: message.replyTo.messageId, uid: message.replyTo.uid,
                fullName: message.replyTo.fullName, textSnippet: (message.replyTo.textSnippet || '').slice(0, 200) } } : {}),
            })) } : {}),
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
        },
        waitSec + 120,
      );
      if (!await current()) return { verdict: 'silence', layer, reason: 'heart_input_changed' };
      const agencyWait = await dispatchWaitViaAgency({
        chatId,
        triggerMessageId: formatted.messageId,
        ...(formatted.uid > 0 ? { triggerUserId: formatted.uid } : {}),
        waitSec,
        reason: `heart:${heart.why || 'wait'}`,
        source: 'meta_heart',
        waitGeneration,
        messageThreadId: formatted.messageThreadId,
        ...(opts.cognitiveAnchorEventId ? { cognitiveAnchorEventId: opts.cognitiveAnchorEventId } : {}),
      });
      if (agencyWait.attempted) {
        if (!agencyWait.accepted) {
          logger.warn(
            { chatId, messageId: formatted.messageId, agencyRunId: agencyWait.agencyRunId, reason: agencyWait.reason },
            'Meta heart wait rejected by Agency authority transport',
          );
          return { verdict: 'silence', layer: 'L1', reason: 'heart_wait_transport_failed' };
        }
      } else {
        await transitionToWait(chatId, waitSec, formatted.messageId, formatted.uid, undefined,
          { waitGeneration, messageThreadId: formatted.messageThreadId });
      }
    } catch (err) {
      // A failed wake-up transport cannot turn a decision to wait into speech.
      logger.warn({ err, chatId }, 'Meta heart wait setup failed; kept silent');
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
    // 「想起再回」埋点：这条 pass 的消息若其实冲着 bot 来（回复 bot/叫名字），
    // 记一笔——当时没接的话头，tick 冷场时可以自然捡回来（真人感）。
    try {
      const text = String(formatted.textContent ?? '');
      const { getBotUid, getBotIdentity } = await import('../bot/bot.js');
      const toBot = formatted.replyTo?.uid === getBotUid(chatId);
      const called = getBotIdentity(chatId).nicknames.some((n) => n && text.includes(n));
      if ((toBot || called) && text.trim()) {
        const { noteMissed } = await import('./missed.js');
        await noteMissed(chatId, {
          messageId: formatted.messageId,
          uid: formatted.uid,
          name: formatted.fullName || formatted.username || `uid:${formatted.uid}`,
          text: text.slice(0, 80),
        });
      }
    } catch {
      /* non-critical */
    }
    logger.info(
      { chatId, why: heart.why, messageId: formatted.messageId, latencyMs: heart.latencyMs },
      'Meta heart: pass',
    );
    return { verdict: 'silence', layer, reason: `heart_pass:${heart.why}` };
  }

  // Addressed QQ questions have already been judged by Heart. Preserve their
  // direct priority through Attention instead of running a second passive gate.
  if (addressed) {
    if (!await beforeEffect()) return { verdict: 'silence', layer, reason: 'heart_input_changed' };
    return { verdict: 'allow', layer: 'L0', reason: `heart:${heart.why || 'addressed_reply'}`, path: heart.path, targetMessageIds: heart.targetMessageIds };
  }

  // reply — NX arm so only one parallel Heart elevate wins; losers silence.
  const { armMetaHeartRefractory, shouldSuppressMetaHeartDispatch } = await import('./heart-refractory.js');
  try {
    // A QQ Heart call can outlive the shorter arm window. Recheck live work and
    // confirmed replies after the model returns, before claiming a new arm.
    if (isPlatformInternalId(chatId) && await shouldSuppressMetaHeartDispatch(chatId)) {
      logger.info({ chatId, messageId: formatted.messageId, reason: 'heart_refractory' }, 'Meta heart: late reply suppressed');
      return { verdict: 'silence', layer: 'L1', reason: 'heart_refractory' };
    }
  } catch { /* Preserve the existing optional refractory read fallback. */ }
  if (!await beforeEffect()) return { verdict: 'silence', layer, reason: 'heart_input_changed' };
  try {
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
  if (!await current()) return { verdict: 'silence', layer, reason: 'heart_input_changed' };
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
    targetMessageIds: heart.targetMessageIds,
    pressureBoost: heart.path === 'lookup' ? 25 : 15,
    path: heart.path,
  };
}
