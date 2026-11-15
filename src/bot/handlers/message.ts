import { getBotUid } from '../../bot/bot.js';
import type { Bot, Context } from 'grammy';
import type { Update } from 'grammy/types';
import { isPlatformInternalId } from '../../platform/identity-store.js';
import { env } from '../../env.js';
import { logger } from '../../shared/logger.js';
import { isDM } from '../../shared/chat.js';
import { isDuplicate } from '../middleware/dedup.js';
import { isRateLimited } from '../middleware/rate-limit.js';
import { enqueue } from '../../queue/producer.js';
import { detectDirectInteraction } from '../../pipeline/timing/direct-interaction.js';
import { isTurnActorChat } from '../../pipeline/turn/actor.js';
import { appendPending } from '../../pipeline/turn/buffer.js';
import { interruptGeneration } from '../../pipeline/turn/abort-registry.js';
import { bumpFocus } from '../../pipeline/turn/focus.js';
import { scheduleTurn } from '../../queue/turn-scheduler.js';
import { getBotIdentity } from '../bot.js';
import * as botClassifierModule from '../../tracking/bot-classifier.js';
import type { FormattedMessage } from '../../shared/types.js';
import { formatMessage } from '../../pipeline/formatter.js';
import { detectReplyObligation, isObligationCancelMessage } from '../../pipeline/turn/obligation-detect.js';
import { saveObligation, setActiveObligation, supersedeActiveObligation, getActiveObligationId, getObligation, updateObligationState } from '../../pipeline/turn/obligation-store.js';
import { isMetaSubagentChat, getAttentionAccumulator } from '../../meta/index.js';
import {
  metaNeedsLegacyPipeline,
  metaMuteBlocksReply,
  tryMetaIngressIntercepts,
} from '../../meta/ingress-intercepts.js';
import { classifyAttentionLayer } from '../../meta/classify-layer.js';
import { heartRoute, hasTimedBypass } from '../../meta/heart-route.js';
import {
  runMetaBookkeepingHooks,
  metaSleepGate,
  messageHasMedia,
} from '../../meta/bookkeeping.js';
import { appendTelegramMessageEvent } from '../../agent/cognitive-events.js';
import { enqueueQqHeartBatch } from '../../meta/qq-heart-batch.js';
import type { QqHeartCandidate } from '../../meta/qq-heart-batch.js';
import { currentIngressIdentity, telegramEventIdentity } from '../../ingress/durable.js';
import { resolveConversationScope } from '../../shared/privacy-scope.js';
import type { UpdateLike } from '../../shared/types.js';
import { processQqHeartBatch } from '../../meta/qq-heart-processor.js';
import { trackIngressTask } from '../../ingress/background.js';
import { observePendingIntent, pendingIntentForEvent, pendingIntentEnabled, inspectPendingIntent } from '../../meta/pending-intent.js';
import { tryHandleUpdateCommand } from '../../admin/update-requests.js';
import { tryHandleJournalConfigCommand } from '../../admin/business-config.js';

/** Shared ingress after each platform has authenticated, filtered and mapped its event. */
export async function ingestChatUpdate(update: Update): Promise<void> {
  const msg = update.message ?? update.edited_message ?? update.channel_post ?? update.edited_channel_post;
  if (!msg) return;

  // Skip forum topic service messages (topic created/edited/closed/reopened) — no user content.
  const msgRecord = msg as unknown as Record<string, unknown>;
  if (msgRecord['forum_topic_created'] || msgRecord['forum_topic_edited'] || msgRecord['forum_topic_closed'] || msgRecord['forum_topic_reopened']) {
    return;
  }

  const chatId = msg.chat.id;
  const messageId = msg.message_id;
  const userId = msg.from?.id;
  const isEdit = !!(update.edited_message ?? update.edited_channel_post);
  const hostUpdate = update as Update & UpdateLike;
  const source = currentIngressIdentity();
  if (source) hostUpdate.__nyatEventIdentity = source;
  else if (!isPlatformInternalId(chatId)) {
    const account = resolveConversationScope(chatId)?.accountId;
    // Never trust an inbound JSON property as host provenance.
    delete hostUpdate.__nyatEventIdentity;
    if (account) hostUpdate.__nyatEventIdentity = telegramEventIdentity(update, account) ?? undefined;
  }
  if (env().MEMORY_PROJECTION_OUTBOX_ENABLED) {
    const sourceMessage = formatMessage(hostUpdate);
    if (sourceMessage) {
      const { persistMemorySource } = await import('../../memory/source-store.js');
      // Store the actual incoming body, before Redis dedup or model enrichment.
      // AI media descriptions are derived material, not a rewrite of this source.
      persistMemorySource(chatId, sourceMessage);
    }
  }

  try {
    if (await isDuplicate(chatId, messageId, isEdit, msg.edit_date, hostUpdate.__nyatEventIdentity?.eventId)) return;
  } catch (err) {
    logger.warn({ err, chatId, messageId }, 'Dedup check failed, proceeding');
  }

  // Deterministic owner commands precede both Meta and legacy model routing.
  if (await tryHandleUpdateCommand(update) || await tryHandleJournalConfigCommand(update)) return;

  if (pendingIntentEnabled() && isMetaSubagentChat(chatId)) {
    const input = formatMessage(hostUpdate);
    if (input) observePendingIntent(chatId, input);
  }

  // G8 A/B 基线的分母。**必须记在这里**:原先埋在 processPipeline 入口,但生产
  // 开着 META_SUBAGENT_ENABLED,Meta 路径从本函数下方直接分流到 heart-adapter,
  // 根本不进队列也不进 processPipeline —— 实测决策 38 次而 msg_seen 只有 4,
  // 分母漏掉了主路径。handleUpdate 是四种 Telegram 事件的唯一收口,记在去重之后
  // (重复投递不算"又看见一条")、分流之前,两条路都覆盖得到。
  trackIngressTask(import('../../metrics/social-ledger.js')
    .then(({ recordMessageSeen }) => recordMessageSeen(chatId))
    .catch(() => { /* telemetry never breaks ingest */ }));

  // AGI-003: durable metadata-only ingress fact. Keep the id locally so every
  // downstream path reads the same event-anchored snapshot.
  const cognitiveAnchorEventId = appendTelegramMessageEvent({
    platform: isPlatformInternalId(chatId) ? 'qq' : 'telegram',
    update: update,
    chatId,
    messageId,
    ...(userId && userId > 0 ? { userId } : {}),
    occurredAt: Math.floor(msg.date ?? Date.now() / 1000),
  });

  // 消息入口可观测（2026-08-22「bot 没回复我」排查的教训：入口没有 info 日志，
  // 「消息到底进没进系统」无法一秒定位）。dedup 之后记，重复投递不算。
  {
    const text = (msg.text ?? msg.caption ?? '') as string | undefined;
    logger.info(
      {
        chatId,
        messageId,
        uid: userId,
        isEdit,
        // telegram 的服务端时间戳（秒）。和我们自己的 time（毫秒）相减就是
        // **发布延迟**：用户按下发送 → telegram 收到 → 推到我们这里。
        // 2026-09-22：用户报"消息从发出到bot收到要4-6s、bot反应10-16s、
        // 发出去3-4s，叠加起来显得迟钝前言不搭后语"。不量就没法判断该修哪段。
        occurredAt: Math.floor(msg.edit_date ?? msg.date ?? Date.now() / 1000),
        preview: (text || '[sticker/图/附件]').slice(0, 40),
      },
      'message in',
    );
  }

  try {
    if (userId && (await isRateLimited(userId))) return;
  } catch (err) {
    logger.warn({ err, userId }, 'Rate limit check failed, proceeding');
  }

  const senderChat = msg.sender_chat;
  const senderChatUsername = senderChat && 'username' in senderChat ? senderChat.username : undefined;
  const senderChatTitle = senderChat && 'title' in senderChat ? senderChat.title : undefined;
  const isAnonymousAdmin = msg.from?.id === 1087968824;
  const displayName = (isAnonymousAdmin || !msg.from)
    ? (senderChatTitle ?? senderChatUsername ?? 'channel')
    : (msg.from.username ?? msg.from.first_name ?? 'unknown');

  logger.debug(
    {
      chatId,
      messageId,
      from: displayName,
      text: (msg.text ?? msg.caption)?.slice(0, 80),
    },
    'Message received',
  );

  const baseData = {
    type: 'message' as const,
    chatId,
    messageId,
    isEdit,
    update: update,
    enqueuedAt: Date.now(),
    cognitiveAnchorEventId,
    eventIdentity: hostUpdate.__nyatEventIdentity,
  };

  // Silence-alert 数据源:人类消息入站埋点(排除 bot 自己 / 匿名频道)。
  // 放在去重+限流之后、Meta/legacy 分流之前——两条路径都覆盖。
  // direct = DM/私聊、@bot、昵称、回复 bot、命令 —— 这类消息 bot 必须接,
  // 群聊普通消息不记 direct(决定不插话是正常行为,不触发沉默告警)。
  if (userId && msg.from && !msg.from.is_bot && userId !== 1087968824) {
    const directKind = detectDirectInteraction(update, {
      botUid: getBotIdentity(chatId).uid,
      botUsername: getBotIdentity(chatId).username,
      botNicknames: getBotIdentity(chatId).nicknames,
      editByContentOnly: true,
    });
    // 沉默告警只关心「bot 必须接话」的消息:
    // - slash 命令(如 /checkin)有自己的 handler 路径,不走 Meta 回复回路 → 不算 direct
    // - bot 睡眠期 @bot 会进 sleep-queue,早晨 catch-up 补回 → 不记 direct(有兜底机制)
    const isSlashCommand = directKind === 'command';
    const qqDiscretion = chatId < 0 && isPlatformInternalId(chatId)
      && env().META_QQ_MENTION_HEART_ENABLED && env().HEART_ENABLED && isMetaSubagentChat(chatId);
    // Heart may deliberately react/pass to a QQ greeting; do not turn that
    // valid decision into a "mandatory text reply missing" silence alert.
    const direct = !isSlashCommand && !qqDiscretion && (isDM(chatId) || directKind !== null);
    if (direct) {
      trackIngressTask(import('../../tracking/reply-activity.js')
        .then(async ({ recordHumanMessage }) => {
          // 睡眠期不记 direct:消息已由 sleep-queue 接管,醒来 catch-up。
          const { isAsleep } = await import('../../tracking/sleep.js');
          if (await isAsleep()) return;
          recordHumanMessage(chatId, { direct: true });
        })
        .catch(() => {}));
    } else {
      // 非 direct 消息也保持 lastHuman 新鲜度(用于 humanStale 判定),但不触发告警。
      trackIngressTask(import('../../tracking/reply-activity.js')
        .then(({ recordHumanMessage }) => recordHumanMessage(chatId))
        .catch(() => {}));
    }
  }

  // Meta+Subagent path: feed Attention; skip legacy reply path (avoid double reply).
  // Slash / checkin·stats NL → legacy. Gacha/game/DM-relay → Meta ingress intercepts.
  if (isMetaSubagentChat(chatId) && (!isEdit || pendingIntentEnabled())) {
    const botIdentity = getBotIdentity(chatId);
    const directKind = detectDirectInteraction(update, {
      botUid: botIdentity.uid,
      botUsername: botIdentity.username,
      botNicknames: botIdentity.nicknames,
      editByContentOnly: true,
    });
    const isDirect = directKind !== null;
    const rawText = msg.text ?? msg.caption ?? '';
    const qqGroup = chatId < 0 && isPlatformInternalId(chatId);
    const qqHeartConfigured = qqGroup && heartRoute(env(), chatId) === 'heart';
    const qqBatchEnabled = qqHeartConfigured && env().META_QQ_GROUP_COALESCE_MS > 0;
    const qqAddressedHeart = qqHeartConfigured && env().META_QQ_MENTION_HEART_ENABLED && isDirect && directKind !== 'command';

    // Fall through BEFORE Meta bookkeeping to avoid duplicate Redis/Qdrant writes.
    if (metaNeedsLegacyPipeline(chatId, rawText, isDirect)) {
      logger.info({ chatId, messageId }, 'Meta path: slash/checkin-stats → legacy pipeline');
      // fall through
    } else {
      const formatted = formatMessage(update);
      if (!formatted) {
        logger.debug({ chatId, messageId }, 'Meta path: formatMessage empty, drop');
        return;
      }
      formatted.pendingIntent = pendingIntentForEvent(formatted.eventIdentity?.eventId);

      const finishMeta = async (fm: typeof formatted): Promise<'done' | 'legacy'> => {
        try {
          const { addMessage } = await import('../../pipeline/context/manager.js');
          await addMessage(chatId, fm, fm.messageThreadId);
        } catch (err) {
          logger.debug({ err, chatId }, 'Meta path: addMessage failed (non-critical)');
        }
        trackIngressTask(import('../../memory/chroma.js')
          .then(({ memorizeMessage }) => memorizeMessage(chatId, fm))
          .catch(() => {}));
        trackIngressTask(import('../../tracking/activity.js')
          .then(({ recordMessage }) => recordMessage(chatId, fm.messageId, fm.uid))
          .catch(() => {}));
        try {
          const { recordUserMessage } = await import('../../tracking/user-profile.js');
          if (fm.role === 'user' && fm.uid > 0) {
            recordUserMessage(
              chatId,
              fm.uid,
              fm.username,
              fm.fullName,
              fm.senderTag,
              fm.textContent,
            );
          }
        } catch {
          /* non-critical */
        }

        runMetaBookkeepingHooks(chatId, fm);

        if (pendingIntentEnabled() && fm.role === 'user' && !fm.isBot && !fm.pendingIntent) {
          logger.warn({ chatId, messageId }, 'Meta input has no authenticated pending-intent source; reply held');
          return 'done';
        }

        // Explicit same-author hold/cancel precedes Heart and direct dispatch.
        // Release re-evaluates this Attention lane; it never sends an old draft.
        if (pendingIntentEnabled() && fm.pendingIntent) {
          const pending = inspectPendingIntent(fm.pendingIntent);
          if (pending.state === 'held' || pending.state === 'cancelled' || fm.pendingIntent.inputControl === 'release') {
            await getAttentionAccumulator().ingestAsync({ chatId, layer: 'L0', reason: 'pending_input_control',
              messageId, userId, textPreview: fm.textContent.slice(0, 200), messageThreadId: fm.messageThreadId,
              cognitiveAnchorEventId, pendingIntent: fm.pendingIntent });
            return 'done';
          }
        }

        // Post-task 发酵窗口:人类群消息额外缓冲进窗口(附加式,不影响下方任何闸门)。
        // 放在 mute/sleep/heart 之前——被这些闸门丢掉的非 direct 消息恰恰是窗口要捞的。
        if (fm.role === 'user' && !fm.isBot && !qqBatchEnabled) {
          try {
            const { ingestIncomingPostTask } = await import('../../subagent/post-task-window.js');
            ingestIncomingPostTask(chatId, {
              messageId: fm.messageId,
              userId: fm.uid,
              username: fm.username || fm.fullName,
              textPreview: (fm.textContent || rawText).slice(0, 200),
              messageThreadId: fm.messageThreadId,
              cognitiveAnchorEventId,
            });
          } catch (err) {
            logger.debug({ err, chatId, messageId }, 'post-task window ingest failed');
          }
        }

        // NyatOS Phase 2.4: ingress shadow. Runs BEFORE any gate so the sample
        // is unbiased — the earlier version sat after the heart branch and only
        // saw 3 of 12 messages, because coalesce/cooldown/engagement had already
        // dropped the rest. Those dropped messages are exactly what the rewrite
        // must be judged on. Fire-and-forget: never delays or blocks the reply.
        const noteLiveOutcome = (outcome: 'spoke' | 'silent' | 'wait' | 'legacy' | 'intercepted' | 'asleep'): void => {
          if (!env().NYATOS_SHADOW_ENABLED) return;
          // Only record for chats the shadow actually observed; otherwise the
          // ledger fills with outcomes that have no matching shadow verdict and
          // the join becomes meaningless.
          trackIngressTask(import('../../nyatos/shadow.js')
            .then(({ isNyatosShadowChat, recordLiveOutcome }) => {
              if (!isNyatosShadowChat(chatId, {
                enabled: env().NYATOS_SHADOW_ENABLED,
                chatIds: env().NYATOS_SHADOW_CHAT_IDS,
              })) return;
              recordLiveOutcome({ chatId, messageId: fm.messageId, outcome });
            })
            .catch(() => { /* telemetry only */ }));
        };
        if (env().NYATOS_SHADOW_ENABLED && fm.role === 'user' && !fm.isBot) {
          trackIngressTask((async () => {
            try {
              const [{ runIngressShadow }, { getRecent }] = await Promise.all([
                import('../../nyatos/shadow.js'),
                import('../../pipeline/context/manager.js'),
              ]);
              const recent = await getRecent(chatId, 20).catch(() => []);
              await runIngressShadow({
                chatId,
                message: fm,
                recent,
                botUid: getBotIdentity(chatId).uid,
                enabled: env().NYATOS_SHADOW_ENABLED,
                chatIds: env().NYATOS_SHADOW_CHAT_IDS,
              });
            } catch (err) {
              logger.debug({ err, chatId }, 'ingress shadow failed (non-critical)');
            }
          })());
        }

        if (metaMuteBlocksReply(chatId, fm, isDirect)) {
          logger.debug({ chatId, uid: fm.uid }, 'Meta path: muted, skip Attention');
          noteLiveOutcome('silent');
          return 'done';
        }

        const intercept = await tryMetaIngressIntercepts(chatId, fm, { isDirect });
        if (intercept === 'handled') {
          logger.info({ chatId, messageId }, 'Meta path: feature intercept handled');
          noteLiveOutcome('intercepted');
          return 'done';
        }
        if (intercept === 'legacy') {
          noteLiveOutcome('legacy');
          return 'legacy';
        }

        const textPreview = (fm.textContent || rawText).slice(0, 200);
        const layerDec = classifyAttentionLayer({
          chatId,
          isDirect,
          directKind,
          text: textPreview,
        });

        const sleep = await metaSleepGate({
          chatId,
          formatted: fm,
          isDirect,
          layer: layerDec.layer === 'L1_CALLBACK' ? 'L1' : layerDec.layer,
          update: update,
          messageId,
        });
        if (sleep === 'silent' || sleep === 'queued') {
          logger.info({ chatId, messageId, sleep, layer: layerDec.layer }, 'Meta path: asleep');
          // Nyat Trench · L0 与睡眠的接口。
          //
          // 论文 §三 机制二里 P 的定义是"想说而未说出口的冲动存量"。睡眠时段 bot
          // 读得到每一条消息却说不了——那正是 P 该积累的时刻，而此前这整段积累
          // 完全不存在。结果就是醒来时 P=0，bot 像什么都没发生过一样。而人是反过
          // 来的：睡一觉错过一整场对话，醒来头几句话是密的、急的，然后才平缓。
          //
          // 这里只做一件事：把"读到但没法回"记成 0.5 的气压。
          // 醒来后多不多说，仍由模型在 Frame 里自己判断——宿主不替它决定。
          //
          // **对所有人类消息计，不只是 queued 的。** 第一版只对 queued 触发，
          // 实测命中率 13/1896 = 0.7%——因为睡眠门用一条硬规则
          //（`layer==='L2' && !isDirect → silent`）预先判定"这条不值得补看"。
          // 但"睡着的时候预先判定醒来会想回哪条"本身就是规则引擎在替模型做判断，
          // 而这个项目的立场是把这类判断交回给模型。所以改按消息本身算，
          // 让 P 反映"我错过了多少",而不是"规则觉得我该错过多少"。
          if (env().TRENCH_SLEEP_PULSE_ENABLED && !fm.isBot) {
            trackIngressTask(import('../../nyatos/trench.js')
              .then(({ pulseForUnheard }) => pulseForUnheard(chatId, 0.5))
              .catch(() => { /* 非关键路径：观测失败不影响睡眠排程 */ }));
            // 定向债：同一个动作再按**发送者**记一笔。标量 P 管速率（不变），
            // 这本账管方向——醒来知道该对谁说。评审 3：无方向的积压醒来后只被
            // 半衰期压平（时钟驱动），有方向则被"还债"驱动（闭环驱动）。
            if (fm.uid > 0) {
              trackIngressTask(import('../../nyatos/debt.js')
                .then(({ oweFor }) => oweFor(chatId, fm.uid, 0.5))
                .catch((err) => logger.warn({ err, chatId, uid: fm.uid }, 'trench debt: record failed')));
            } else {
              logger.warn({ chatId }, 'trench debt: skipped, fm.uid not > 0');
            }
          }
          // 睡眠记 'asleep' 而不是 'silent'：实测睡眠占 silent 的 15%，
          // 混在一起会让"心流否决率"虚高——那不是心流的决定，是作息。
          noteLiveOutcome('asleep');
          return 'done';
        }

        // Passive group chat: Heart decides是否插话 → 升 L1 再进 Meta。
        // Heart 本身就是 gate（含 cooldown/engagement/wait/pass），放行后
        // 不再跑 Meta timing——否则会和 Heart 双重否决、把已批准的插话掐掉。
        // Direct/L0 仍直通 Meta；HEART 关时保持旧 L2 硬丢。
        //
        // Same-speaker burst: 正在回这个人的 L0 / CodeAct 占线时，后续无 @ 气泡
        // 也升 L0（否则 Heart busy 会把「钱包还有多少」整句丢掉）。
        if (!qqBatchEnabled && !isDirect && layerDec.layer !== 'L0' && userId && userId > 0) {
          try {
            const { shouldForceSameSpeakerL0, markSpeakerBurst } = await import(
              '../../meta/speaker-burst.js'
            );
            if (await shouldForceSameSpeakerL0(chatId, userId)) {
              await getAttentionAccumulator().ingestAsync({ pendingIntent: fm.pendingIntent,
                chatId,
                layer: 'L0',
                reason: 'same_speaker_burst',
                messageId,
                userId,
                textPreview,
                pressure: 100,
                messageThreadId: fm.messageThreadId,
                cognitiveAnchorEventId,
                payload: {
                  username: fm.username || undefined,
                  fullName: fm.fullName || undefined,
                  ...(fm.replyTo
                    ? {
                        replyTo: {
                          messageId: fm.replyTo.messageId,
                          uid: fm.replyTo.uid,
                          fullName: fm.replyTo.fullName,
                          textSnippet: (fm.replyTo.textSnippet ?? '').slice(0, 200),
                        },
                      }
                    : {}),
                },
              });
              await markSpeakerBurst(chatId, userId);
              logger.info(
                { chatId, messageId, uid: userId },
                'Meta attention ingested (same_speaker_burst)',
              );
              // 入账：这条消息**没有问过心流**就被强制摄进 attention。
              //
              // 不记的后果（2026-09-19 实测）：近 24h 有约 401 个绕过事件
              // （same_speaker_burst 279 + post-task 122）从未进 live_outcome 账本，
              // 占决策事件约 23%。于是任何基于 social_prediction 的对照分析都会
              //  systematically 漏掉"绕过心流的那部分"——而 Phase 1 要测的恰恰是
              // "判定点 vs 心流"，漏掉它等于把要测的对象排除在样本外。
              noteLiveOutcome('intercepted');
              return 'done';
            }
          } catch (err) {
            logger.debug({ err, chatId, messageId }, 'same_speaker_burst check failed — Heart path');
          }
        }

        if (qqAddressedHeart || (!isDirect && layerDec.layer !== 'L0')) {
          const { env } = await import('../../env.js');
          // Nyat Trench Phase 1 预备：Meta heart 是这个仓库实际在做抑制的那一层
          // （实测 12,009 次判定只放行 7.7%，而影子想 speak 85.6%）。
          //
          // META_HEART_ENABLED=false 时**旁路它的 allow/silence 裁决**，消息仍按
          // 既有的 layer 分级进 attention（见下方 else 分支）——只是不再被心流二次否决。
          // 单独设 META_HEART_ENABLED=false **不会**静音：只有配 HEART_ENABLED=false
          // 才会整段不走，那是既有的总开关。
          //
          // 默认 true（当前行为，零变化）。翻成 false 之前必须先有两样东西：
          //   ① envelope 从 shadow 拨到 enforce 并读过真实拦截率（论文 §九·补五）
          //   ② 金丝雀的 Phase 2 一致率与发送量曲线可作为对照基线
          // 顺序反了就是把刹车片拔了再装新的。
          // 传 chatId：旁路支持按群灰度（名单优先于全局开关），
          // 这样"先开一个群试试"不要求先全局翻旗。
          // 额外查时限旁路：TTL 到期自动恢复，实验因此不需要有人记得撤。
          const timedBypass = await hasTimedBypass(chatId).catch(() => false);
          const heartPath = timedBypass ? 'bypass' : heartRoute(env(), chatId);

          // ── bot 消息分类 + 降噪：Meta 路径也要走 ──────────────────────
          //
          // **这是"搭配验证 bot"的真正缺口**：botClass 只在 processPipeline 里算，
          // 而生产主路径（META_SUBAGENT_ENABLED 开着）从本函数下方直接分流到
          // heart-adapter，根本不进 processPipeline——于是分类和降噪在主路径上
          // 从未生效，nmnmfunbot（入群验证 bot）的消息照常拿到 heart 判定并被回复
          // （实测 6 次，含 2026-09-20 04:55）。
          //
          // 修法不是加规则，是把宿主已经算出的那个事实（botClass）在本路径也算出来，
          // 并按 BOT_DENOISE_ENABLED 尊重它。verify/ad/echo 三类是"非对话型 bot"，
          // 宿主据此不烧心流；其余照旧。
          if (fm.isBot && Number(fm.uid ?? 0) !== getBotUid(chatId) && chatId < 0) {
            // bot 消息的两道闸（结构 + 语义）抽在 meta-bot-gate.ts —— 单一来源、可单测。
            // 内联在闭包里那段没有任何测试能碰到，round 1 的"验证 bot 被回复 6 次"
            // 就是这个缺口的结果。详细理由见那个文件顶部。
            const gateVerdict = await (async (): Promise<'ignore-structural' | 'denoise-semantic' | 'pass'> => {
              try {
                const { decideBotMessage } = await import('./meta-bot-gate.js');
                const envNow = env();
                const cls = (m: FormattedMessage): string => {
                  try {
                    const { classifyBotMessage } = botClassifierModule;
                    return classifyBotMessage(m, {});
                  } catch {
                    return 'unknown';
                  }
                };
                return decideBotMessage(
                  fm,
                  { uid: botIdentity.uid, username: botIdentity.username, nicknames: botIdentity.nicknames },
                  cls,
                  {
                    classifierEnabled: envNow.BOT_CLASSIFIER_ENABLED === true,
                    denoiseEnabled: envNow.BOT_DENOISE_ENABLED === true,
                  },
                );
              } catch (err) {
                logger.debug({ err, chatId }, 'Meta path bot gate failed (non-critical)');
                return 'pass';
              }
            })();

            if (gateVerdict === 'ignore-structural') {
              logger.info(
                { chatId, bot: fm.username },
                'Meta path: bot 未称呼本喵，结构性忽略（不烧心流）',
              );
              noteLiveOutcome('silent');
              return 'done';
            }
            if (gateVerdict === 'denoise-semantic') {
              logger.info(
                { chatId, bot: fm.username },
                'Meta path: denoise silenced a non-conversational bot',
              );
              noteLiveOutcome('silent');
              return 'done';
            }
          }

          if (heartPath === 'heart') {
            const processHeartBatch = async (batch: QqHeartCandidate[], signal: AbortSignal): Promise<void> => {
              const anchor = batch[batch.length - 1]!;
              const directlyAddressed = batch.some(item => item.addressed);
              const ongoingFollowup = !directlyAddressed && batch.some(item => item.ongoingFollowup);
              const addressed = directlyAddressed || ongoingFollowup;
              try {
                const { evaluateMetaHeart } = await import('../../meta/heart-adapter.js');
                const heart = await evaluateMetaHeart({
                  chatId,
                  formatted: anchor.formatted,
                  layer: anchor.layer,
                  cognitiveAnchorEventId: anchor.cognitiveAnchorEventId,
                  addressed,
                  ongoingFollowup,
                  batchMessages: batch.map(item => item.formatted),
                  signal,
                });
                if (signal.aborted) return;
                if (heart.verdict !== 'allow') {
                  // Silence decided by the heart (cooldown / engagement / pass /
                  // refractory). Recording it lets the shadow comparison ask the
                  // question that matters: "the gate said no — would a single
                  // decision have spoken?"
                  noteLiveOutcome(heart.reason?.startsWith('heart_wait') ? 'wait' : 'silent');
                  return;
                }
                // 心流**放行**也要入账。
                //
                // `recordLiveOutcome` 的类型联合里有 'spoke'，文档说"记录 live path
                // 实际做了什么"，但全仓没有任何调用方传过它——金丝雀的【决策来源】
                // 分布里 spoke 恒为 0。于是账本只记否决、不记放行，
                // "shadow 想说 vs live 做了"的这个 join 少了一半。
                //
                // 放过之后仍可能因别的原因没真的发出去（被下游守卫拦、任务失败），
                // 所以这里记的是心流的**裁决**（放行），不是"最终发出"——
                // 后者由 self_replies 记。两者互补，不重复。
                noteLiveOutcome('spoke');

                const elevLayer = heart.layer;
                const elevReason = heart.reason;
                const elevBoost = heart.pressureBoost ?? 0;

                const basePressure = elevLayer === 'L0' ? 100 : elevLayer === 'L1' ? 70 : 30;
                for (const item of batch) {
                  if (signal.aborted) return;
                  const message = item.formatted;
                  await getAttentionAccumulator().ingestAsync({ pendingIntent: message.pendingIntent,
                    chatId,
                    layer: elevLayer,
                    reason: elevReason,
                    messageId: message.messageId,
                    userId: message.uid,
                    textPreview: (message.textContent || '').slice(0, 200),
                    pressure: basePressure + elevBoost,
                    messageThreadId: message.messageThreadId,
                    cognitiveAnchorEventId: item.cognitiveAnchorEventId,
                    payload: {
                      username: message.username || undefined,
                      fullName: message.fullName || undefined,
                      heartPath: heart.path,
                      ...(message.replyTo
                        ? { replyTo: {
                          messageId: message.replyTo.messageId,
                          uid: message.replyTo.uid,
                          fullName: message.replyTo.fullName,
                          textSnippet: (message.replyTo.textSnippet ?? '').slice(0, 200),
                        } }
                        : {}),
                    },
                  });
                }
                logger.info(
                  { chatId, messageId, layer: elevLayer, reason: elevReason },
                  'Meta attention ingested (heart)',
                );
              } catch (err) {
                if (signal.aborted) return;
                if (qqGroup) {
                  // Model failures are handled as wait by Heart. An unrelated
                  // infrastructure error (including recall storage) must not
                  // turn unverified QQ input into a forced text task.
                  logger.warn({ chatId, messageId: anchor.formatted.messageId }, 'QQ Heart batch unavailable; no text fallback');
                  return;
                }
                // Infra failure ≠ Heart "pass". Fail-open once into Attention so the
                // msg isn't silently lost; gap-fill may still dispatch.
                logger.warn({ err, chatId, messageId }, 'Meta heart path failed — soft ingest');
                try {
                  await getAttentionAccumulator().ingestAsync({ pendingIntent: fm.pendingIntent,
                    chatId,
                    layer: addressed ? 'L0' : 'L1',
                    reason: 'heart:infra_fail',
                    messageId: anchor.formatted.messageId,
                    userId: anchor.formatted.uid,
                    textPreview: (anchor.formatted.textContent || '').slice(0, 200),
                    pressure: 55,
                    messageThreadId: fm.messageThreadId,
                    cognitiveAnchorEventId,
                    payload: {
                      username: fm.username || undefined,
                      fullName: fm.fullName || undefined,
                      ...(fm.replyTo
                        ? {
                            replyTo: {
                              messageId: fm.replyTo.messageId,
                              uid: fm.replyTo.uid,
                              fullName: fm.replyTo.fullName,
                              textSnippet: (fm.replyTo.textSnippet ?? '').slice(0, 200),
                            },
                          }
                        : {}),
                    },
                  });
                } catch (err2) {
                  logger.warn({ err: err2, chatId, messageId }, 'Meta heart soft ingest failed');
                }
              }
            };
            const candidate: QqHeartCandidate = { chatId, formatted: fm, layer: layerDec.layer,
              addressed: qqAddressedHeart, cognitiveAnchorEventId };
            if (qqBatchEnabled && !candidate.addressed && fm.uid > 0) {
              const { isInFlightCodeActForUser } = await import('../../meta/speaker-burst.js');
              // This is a same-chat active task for this exact sender, not a
              // general group continuation or permission for other members.
              candidate.ongoingFollowup = isInFlightCodeActForUser(chatId, fm.uid);
            }
            if (qqBatchEnabled) enqueueQqHeartBatch(candidate, (batch, signal) => processQqHeartBatch(batch, signal, noteLiveOutcome));
            else trackIngressTask(processHeartBatch([candidate], new AbortController().signal));
            return 'done';
          }

          // Phase 1 旁路：心流不再裁决，但消息**仍要进 attention**。
          //
          // 第一版写成"META_HEART_ENABLED 假就整块跳过"，结果 ingest 完全不发生——
          // bot 直接静音，而不是"按 layer 分级进 attention"。注释与代码不一致，
          // 而且正是这个仓库最爱的那类失败。这里显式补上 ingest。
          //
          // 触发条件是负向的（HEART_ENABLED 开着而 META_HEART_ENABLED 关着），
          // 所以单独设 META_HEART_ENABLED=false 不会静音，也不会无人接管。
          if (heartPath === 'bypass') {
            // 可观测性：旁路生效时必须留一条 info。**第一版这里一行日志都没有**，
            // 于是往灰名单放了群之后，无法从日志判断旁路是否真的在跑——
            // 而灰度实验的全部意义就是"能看出开关生效了没有"。
            // 计数由金丝雀的 "Meta heart: BYPASSED" 读取，作为灰度生效的判据之一。
            logger.info(
              { chatId, messageId, layer: layerDec.layer },
              'Meta heart: BYPASSED (trench grey release)',
            );
            trackIngressTask((async () => {
              try {
                // 被旁路掉的裁决记成 wait：让 shadow 对照能看到"心流本来会参一脚",
                // 而不是假装它没发生过。
                noteLiveOutcome('wait');
                await getAttentionAccumulator().ingestAsync({ pendingIntent: fm.pendingIntent,
                  chatId,
                  layer: layerDec.layer,
                  reason: `trench_bypass_${layerDec.layer}`,
                  messageId,
                  userId,
                  textPreview,
                  // 分级压升沿用心流自己的基准，不引入新的经验参数。
                  pressure: layerDec.layer === 'L0' ? 100 : layerDec.layer === 'L1' ? 70 : 30,
                  messageThreadId: fm.messageThreadId,
                  cognitiveAnchorEventId,
                  payload: {
                    username: fm.username || undefined,
                    fullName: fm.fullName || undefined,
                    heartPath: 'trench_bypass',
                    ...(fm.replyTo
                      ? {
                          replyTo: {
                            messageId: fm.replyTo.messageId,
                            uid: fm.replyTo.uid,
                            fullName: fm.replyTo.fullName,
                            textSnippet: (fm.replyTo.textSnippet ?? '').slice(0, 200),
                          },
                        }
                      : {}),
                  },
                });
              } catch (err) {
                logger.debug({ err, chatId, messageId }, 'trench bypass ingest failed');
              }
            })());
            return 'done';
          }

          // Heart 全关：L2 旁观硬丢（旧行为）。META_DEFER_ENABLED 时放行进 gate。
          if (layerDec.layer === 'L2' && !env().META_DEFER_ENABLED) {
            logger.debug({ chatId, messageId }, 'Meta path: L2 drop (no Attention)');
            // 丢弃也是 live 的一个裁决，要入账。2026-09-19 实测账本闭合率只有 77%，
            // 缺口主要就是这两条 drop 分支——它们让 shadow 判定过的消息没有对应 outcome，
            // 于是"shadow 想说 vs live 做了"这个 join 少了四分之一。
            noteLiveOutcome('silent');
            return 'done';
          }
        }

        // Timing gate — for L0/direct (bypasses to allow), Heart-off L1, and
        // (with META_DEFER_ENABLED) L2. Heart path skips this.
        try {
          const { evaluateMetaTiming } = await import('../../meta/timing-adapter.js');
          const timing = await evaluateMetaTiming({
            chatId,
            formatted: fm,
            isDirect,
            layer: layerDec.layer,
            directKind,
            cognitiveAnchorEventId,
          });
          if (timing.verdict === 'silence') {
            logger.info(
              { chatId, messageId, layer: layerDec.layer, reason: timing.reason },
              'Meta path: timing gate silence',
            );
            noteLiveOutcome(/^(wait|defer):/.test(timing.reason) ? 'wait' : 'silent');
            return 'done';
          }
        } catch (err) {
          logger.warn({ err, chatId }, 'Meta timing gate failed — fail-open to Attention');
        }

        // Typing starts at CodeAct (executor heartbeat), not here — coalesce may
        // hold L0/L1 for META_L0_COALESCE_MS and premature typing looks stuck.

        const basePressure =
          layerDec.layer === 'L0' ? 100 : layerDec.layer === 'L1' ? 60 : 30;
        // 定向债 → 注意力权重（论文 §九·补六 实验 B，TRENCH_DEBT_ATTENTION_ENABLED）。
        //
        // 实测：债在 Frame 里被呈现，而醒来后 28 个债主、10 个在场发言、0 次被选。
        // 也就是"被看见但不进选择"。这一条把债接到**选择侧**——来自债主的人类消息
        // 在累加时获得固定压力加成。它是宿主侧的确定性加权：不改模型、不删机制、
        // 可单独 revert；关掉时行为与上一版完全一致。
        let debtBoost = 0;
        if (env().TRENCH_DEBT_ATTENTION_ENABLED === true && Number.isSafeInteger(userId ?? 0) && (userId ?? 0) > 0) {
          const owed = await import('../../nyatos/debt.js')
            .then((m) => m.owedTo(chatId, userId ?? 0))
            .catch(() => 0);
          if (owed > 0) debtBoost = env().TRENCH_DEBT_ATTENTION_BOOST;
        }
        await getAttentionAccumulator().ingestAsync({ pendingIntent: fm.pendingIntent,
          chatId,
          layer: layerDec.layer,
          reason: layerDec.reason,
          messageId,
          userId,
          textPreview,
          pressure: basePressure + (layerDec.pressureBoost ?? 0) + debtBoost,
          messageThreadId: fm.messageThreadId,
          cognitiveAnchorEventId,
          payload: {
            username: fm.username || undefined,
            fullName: fm.fullName || undefined,
            ...(fm.replyTo
              ? {
                  replyTo: {
                    messageId: fm.replyTo.messageId,
                    uid: fm.replyTo.uid,
                    fullName: fm.replyTo.fullName,
                    textSnippet: (fm.replyTo.textSnippet ?? '').slice(0, 200),
                  },
                }
              : {}),
          },
        });
        if (layerDec.layer === 'L0' && userId && userId > 0 && chatId < 0) {
          try {
            const { markSpeakerBurst } = await import('../../meta/speaker-burst.js');
            await markSpeakerBurst(chatId, userId);
          } catch {
            /* non-critical */
          }
        }
        logger.info({ chatId, messageId, layer: layerDec.layer }, 'Meta attention ingested');
        // 这条路径**不问心流**（L0 / direct / timing gate 放行后）直接进 attention。
        // 与 same_speaker_burst、post-task 并列，是绕过心流的第三条/第四条路径。
        // 不记的后果同上：join 缺样本。记 'intercepted' ——被拦下未经心流裁决，
        // 由更便宜的确定性层直接放行。
        noteLiveOutcome('intercepted');
        return 'done';
      };

      // Vision/sticker off the grammY hot path — ingest text first when media-heavy.
      if (messageHasMedia(formatted)) {
        trackIngressTask((async () => {
          try {
            const { processMedia } = await import('../../pipeline/stages/media.js');
            await processMedia(formatted, chatId);
          } catch (err) {
            logger.debug({ err, chatId }, 'Meta path: deferred processMedia failed');
          }
          const result = await finishMeta(formatted);
          if (result === 'legacy') {
            logger.warn({ chatId, messageId }, 'Meta deferred path cannot fall through — drop');
          }
        })());
        return;
      }

      const result = await finishMeta(formatted);
      if (result === 'legacy') {
        logger.info({ chatId, messageId }, 'Meta path: intercept → legacy');
        // fall through
      } else {
        return;
      }
    }
  }

  if (isTurnActorChat(chatId)) {
    const botIdentity = getBotIdentity(chatId);
    const directKind = detectDirectInteraction(update, {
      botUid: botIdentity.uid,
      botUsername: botIdentity.username,
      botNicknames: botIdentity.nicknames,
      editByContentOnly: true,
    });
    const isDirect = directKind !== null;

    const formatted = formatMessage(update);
    const activeObligationId = await getActiveObligationId(chatId);
    const activeObligation = activeObligationId ? await getObligation(chatId, activeObligationId) : null;
    const isCancel =
      !!formatted &&
      !!activeObligationId &&
      isObligationCancelMessage(formatted, activeObligation ?? undefined);
    if (isCancel && activeObligationId) {
      await updateObligationState(chatId, activeObligationId, 'dropped', { reason: 'user_cancelled' });
    }
    const obligation = formatted && !isCancel
      ? detectReplyObligation({
          chatId,
          message: formatted,
          directKind,
        })
      : null;
    if (obligation) {
      await saveObligation(obligation);
      if (obligation.mustReplyStrong) {
        await supersedeActiveObligation(chatId, obligation.id);
        await setActiveObligation(chatId, obligation.id);
      }
    }

    if (!isEdit) {
      interruptGeneration(chatId, isDirect ? 'direct_message' : 'new_message');
      if (chatId < 0) {
        trackIngressTask(bumpFocus(chatId, isDirect ? 'direct_interaction' : 'passive_message').catch(() => {}));
      }
    }

    const msgTextRaw = (msg.text ?? msg.caption ?? '').trim();
    const stillTyping =
      !isEdit &&
      msgTextRaw.length > 0 &&
      msgTextRaw.length < 60 &&
      !/[。.!?！？…~〜)）」』"”\]】]$/.test(msgTextRaw);

    await appendPending({
      update: update,
      chatId,
      messageId,
      enqueuedAt: Date.now(),
      direct: isDirect,
      isEdit,
      cognitiveAnchorEventId,
      obligationId: obligation?.id,
      obligationTargetUid: obligation?.targetUid,
      obligationStrong: obligation?.mustReplyStrong,
    });
    await scheduleTurn(chatId, {
      trigger: isDirect ? 'direct' : 'message',
      direct: isDirect,
      stillTyping,
      noReschedule: isEdit && !isDirect,
      obligationId: obligation?.id,
      obligationTargetUid: obligation?.targetUid,
      obligationStrong: obligation?.mustReplyStrong,
    });
    return;
  }

  await enqueue(baseData);
}

export function registerMessageHandlers(bot: Bot): void {
  bot.on('message', handleUpdate);
  bot.on('edited_message', handleUpdate);
  bot.on('channel_post', handleUpdate);
  bot.on('edited_channel_post', handleUpdate);
}

async function handleUpdate(ctx: Context): Promise<void> {
  // Telegram identifiers fit in 52 bits. Reserved internal IDs only enter via
  // the authenticated platform gateway, never from a Telegram update.
  const msg = ctx.message ?? ctx.editedMessage ?? ctx.channelPost ?? ctx.editedChannelPost;
  if (msg && [msg.chat.id, msg.from?.id, msg.message_id].some(id => id !== undefined && isPlatformInternalId(id))) {
    logger.warn('Rejected Telegram update with reserved platform identifier');
    return;
  }
  await ingestChatUpdate(ctx.update);
}
