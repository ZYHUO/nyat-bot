// Side effects Meta path must keep when skipping processPipeline bookkeeping.
import type { FormattedMessage } from '../shared/types.js';
import type { UpdateLike } from '../shared/types.js';
import { logger } from '../shared/logger.js';
import { env } from '../env.js';

/** Fire-and-forget hooks that pipeline used to run before judge. */
export function runMetaBookkeepingHooks(chatId: number, formatted: FormattedMessage): void {
  // DM affinity + pending flush
  if (chatId > 0 && formatted.uid > 0 && !formatted.isBot) {
    void (async () => {
      try {
        const { markDmEver } = await import('../tracking/dm-state.js');
        markDmEver(formatted.uid);
        const { countDmPending } = await import('../tracking/dm-pending.js');
        if (countDmPending(formatted.uid) > 0) {
          const { flushDmPendingOnInbound } = await import('../pipeline/dm-proactive.js');
          await flushDmPendingOnInbound(formatted.uid);
        }
      } catch (err) {
        logger.debug({ err }, 'Meta: DM affinity hook failed');
      }
    })();
  }

  // DM wake poke
  if (chatId > 0 && env().SLEEP_WAKE_ON_DM_ENABLED) {
    void import('../tracking/sleep.js')
      .then(({ pokeGlobalWake }) => pokeGlobalWake('dm'))
      .catch(() => {});
  }

  // 多 bot 共存：peer reaction + network burst。
  //
  // 2026-09-21 发现这两个功能**在生产里从未运行过**：它们的唯一调用方在
  // `pipeline/pipeline.ts`（legacy 路径），而生产主路径是 Meta，根本不进
  // processPipeline。旗标 PEER_REACTION_ENABLED / NETWORK_BURST_ENABLED 都是
  // true，日志里 `Peer reaction sent` / `Network burst: chimed in` **零次**。
  //
  // 死开关守卫没抓到这件事：它查"有没有人读这个旗标"，而 pipeline.ts:210 确实读
  // 了——但那条路在生产不跑。**"有读者"和"读者在主路径上"是两件事。**
  //
  // 两个 hook 都自带 chat-lock / fatigue / 作息 / 概率门（见各自实现），
  // 且 fire-and-forget，挂在这里不阻塞 ingest。
  if (chatId < 0 && formatted.uid > 0) {
    void (async () => {
      try {
        const { getBotUid } = await import('../bot/bot.js');
        const botUid = getBotUid();
        if (formatted.isBot && formatted.uid !== botUid) {
          const bc = formatted.botClass;
          if (env().PEER_REACTION_ENABLED && (bc === 'chat' || bc === 'cmd_result')) {
            const { maybePeerReaction } = await import('../pipeline/games/peer-reaction.js');
            await maybePeerReaction(chatId, formatted, botUid);
          }
        }
        if (!formatted.isBot && env().NETWORK_BURST_ENABLED) {
          const { maybeNetworkBurst } = await import('../pipeline/games/network-burst.js');
          await maybeNetworkBurst(chatId, formatted, botUid);
        }
      } catch (err) {
        logger.debug({ err }, 'Meta: peer-reaction / network-burst failed');
      }
    })();
  }

  // 代发回执：这条 bot 消息是不是我们代发命令的结果？
  //
  // 2026-09-21 发现：`bots.command`（沙盒 API，跑在 Meta 主路径上的 subagent 才能调）
  // 会写一个 pending key，而消费它的 `tryHandleDelegationReceipt` **只在 legacy 的
  // pipeline/pipeline.ts:172 被调用**。Meta 路径上 grep "delegation" 零命中。
  //
  // 于是：subagent 借 nmbot 办了事 → nmbot 在群里回 → 那条回执走 Meta 路径 →
  // **没人认领**，原问题永远等不到答案，pending key 只能等 TTL 过期。
  //
  // 和上一轮 peer-reaction / network-burst 是同一个病：功能接在了一条
  // 生产不走的路上。日志证据：`Delegation: reply-command sent (bot 代罚)` 零次，
  // `Pipeline complete (delegation receipt handled)` 零次——两头都没跑过。
  //
  // 放在 bookkeeping hooks 里（message.ts:212，早于心流裁决和 bot 分类降噪），
  // 这样回执能在被当普通 bot 消息忽略之前被认领。
  if (formatted.isBot && formatted.uid > 0 && chatId < 0 && env().BOT_DELEGATION_ENABLED) {
    void (async () => {
      try {
        const [{ tryHandleDelegationReceipt }, { getBotUid }] = await Promise.all([
          import('../pipeline/tools/bot-delegation.js'),
          import('../bot/bot.js'),
        ]);
        const handled = await tryHandleDelegationReceipt(chatId, formatted, getBotUid());
        if (handled) {
          logger.info({ chatId, bot: formatted.username }, 'Meta: delegation receipt handled');
        }
      } catch (err) {
        logger.debug({ err }, 'Meta: delegation receipt check failed (non-critical)');
      }
    })();
  }

  // Reply-outcome observation. The legacy pipeline does this in
  // pipeline/stages/bookkeeping.ts; Meta skips that stage entirely, so without
  // this hook the outcomes of every conversation reply sent on the main path
  // would never resolve — the self-history facts shown to the model would stay
  // "unknown" forever, and mood/relationship effects would never apply.
  if (env().OUTCOME_TRACKING_ENABLED && formatted.uid > 0 && !formatted.isBot) {
    void (async () => {
      try {
        const [{ checkOutcome, generateReflection }, { getBotIdentity }, { callWithFallback }] =
          await Promise.all([
            import('../tracking/outcome.js'),
            import('../bot/bot.js'),
            import('../ai/fallback.js'),
          ]);
        const { needsReflection } = await checkOutcome(chatId, formatted, getBotIdentity().username);
        if (!needsReflection) return;
        await generateReflection(chatId, async (prompt) => {
          try {
            const result = await callWithFallback({
              usage: 'summarize',
              messages: [{ role: 'user', content: prompt }],
              maxTokens: 300,
              temperature: 0.3,
            });
            return result.content;
          } catch (err) {
            logger.warn({ err, chatId }, 'Meta: reflection AI call failed');
            return null;
          }
        });
      } catch (err) {
        logger.debug({ err, chatId }, 'Meta: outcome check failed (non-critical)');
      }
    })();
  }

  // World facts: record what Telegram reports about this chat (title, type,
  // username, description) as host-observable world entities. The World
  // projection had a consumer but no producer — nothing ever emitted
  // `world_change`, so `world_entities` stayed empty. Cached for 30 min inside
  // the module, so this is one getChat per chat per half hour, not per message.
  if (env().WORLD_FACTS_ENABLED) {
    void import('../agent/world-facts.js')
      .then(({ observeAndRecordChatFacts }) => observeAndRecordChatFacts(chatId, true))
      .catch((err) => logger.debug({ err, chatId }, 'Meta: world facts failed (non-critical)'));
  }
}

export type MetaSleepVerdict = 'continue' | 'queued' | 'silent';

/** Sleep Stage B analogue for Meta Attention. */
export async function metaSleepGate(opts: {
  chatId: number;
  formatted: FormattedMessage;
  isDirect: boolean;
  layer: 'L0' | 'L1' | 'L2';
  update: UpdateLike;
  messageId: number;
}): Promise<MetaSleepVerdict> {
  const { chatId, formatted, isDirect, layer, update, messageId } = opts;
  try {
    const { getSleepPhase, sleepWakeDecision } = await import('../tracking/sleep.js');
    const phase = await getSleepPhase();
    if (phase === 'awake') return 'continue';

    // Passive L2 while asleep: don't burn Attention / queue (pipeline Stage A would often silence).
    if (layer === 'L2' && !isDirect) return 'silent';

    const rule =
      chatId > 0
        ? 'private_chat'
        : isDirect
          ? 'mention_self'
          : undefined;
    const verdict = await sleepWakeDecision(chatId, formatted.uid, rule, phase);
    if (verdict === 'wake' || verdict === 'pass') {
      const { clearSleepPending } = await import('../tracking/sleep-queue.js');
      if (verdict === 'wake') await clearSleepPending(chatId);
      return 'continue';
    }

    // queue
    const { pushSleepPending } = await import('../tracking/sleep-queue.js');
    await pushSleepPending(chatId, {
      entry: {
        update,
        chatId,
        messageId,
        enqueuedAt: Date.now(),
        waitReplay: true,
        sleepCatchup: true,
      },
      rule: rule ?? 'passive_chat',
      ts: Date.now(),
    });
    return 'queued';
  } catch (err) {
    logger.debug({ err, chatId }, 'Meta sleep gate failed — continue');
    return 'continue';
  }
}

export function messageHasMedia(formatted: FormattedMessage): boolean {
  return !!(
    formatted.imageFileId ||
    formatted.sticker ||
    formatted.audioFileId ||
    formatted.voiceFileId ||
    formatted.documentFileId ||
    formatted.videoFileId ||
    formatted.videoNoteFileId ||
    formatted.replyTo?.imageFileId
  );
}
