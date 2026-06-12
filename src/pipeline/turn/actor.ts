// ────────────────────────────────────────
// Turn Actor — per-chat 认知回合主体
// ────────────────────────────────────────
//
// 回合开火时原子取走整个 pending burst,逐条喂给现有 processPipeline:
//   - direct 条目与最后一条 → 完整 judge→gate→reply(可被打断,G3)
//   - 其余 → tracking-only(与旧 debounce 的 isLastInBatch 语义 1:1)
//   - WAIT/STOP 且无 direct → 整批 tracking-only(与旧 ingress 抑制等价)
// 回合结束时若期间有新消息(dirty / pending 非空)→ 立即再排程,
// 保证同 chat 永远只有一个回合在跑(G12 的结构性解)。
//
// G3 打断闭环(MaiBot 语义):
//   ingress 新消息 → interruptGeneration → 写手调用以 AI_ABORTED 浮出 →
//   等静默期(用户这波话说完)→ 重排 pending → 以最新消息为锚、跳过
//   timing gate 重规划。连续打断受 TURN_INTERRUPT_MAX_CONSECUTIVE 约束,
//   超限后当前生成被放行(注册表层面拒绝打断)。

import type { MessageJobData } from '../../queue/jobs.js';
import { processPipeline } from '../pipeline.js';
import {
  drainPending,
  pendingCount,
  clearDirty,
  clearScheduledJob,
  bumpEpoch,
} from './buffer.js';
import { registerGeneration, clearGeneration } from './abort-registry.js';
import { waitForMessageQuiet } from './quiet-period.js';
import { scheduleTurn } from '../../queue/turn-scheduler.js';
import { getChatState, transitionToRunning } from '../timing/chat-runtime.js';
import type { PendingEntry } from './types.js';
import { AIError } from '../../shared/errors.js';
import { env } from '../../env.js';
import { logger } from '../../shared/logger.js';

export { isTurnActorChat } from './flags.js';

/**
 * 单个 judged entry 的重规划上限,从回合内部轮次预算导出:
 * TURN_MAX_INTERNAL_ROUNDS(默认 4)≈ 首次生成 + replans + 自我接话余量。
 * NaN/缺失时回退 2 —— 这里绝不能因配置问题变成无限循环。
 */
function maxReplans(): number {
  const rounds = Number(env().TURN_MAX_INTERNAL_ROUNDS);
  const base = Number.isFinite(rounds) ? rounds - 2 : 2;
  return Math.min(4, Math.max(1, base));
}

function isAbortError(err: unknown): boolean {
  return err instanceof AIError && err.code === 'AI_ABORTED';
}

/**
 * burst 条目是否斜杠命令(与 L0 getCommandName 对齐:带 @suffix 时必须
 * 指向本 bot)。命令条目逐条 judged —— 签到/帮助这类回执是事务,不参与
 * "每回合一个聊天锚点"的预算。
 */
function isCommandEntry(entry: PendingEntry, botUsername: string): boolean {
  const u = entry.update as {
    message?: unknown;
    edited_message?: unknown;
    channel_post?: unknown;
    edited_channel_post?: unknown;
  };
  const msg = (u.message ?? u.edited_message ?? u.channel_post ?? u.edited_channel_post) as
    | { text?: unknown; caption?: unknown }
    | undefined;
  const text =
    (typeof msg?.text === 'string' ? msg.text : '') ||
    (typeof msg?.caption === 'string' ? msg.caption : '');
  const m = text.trim().match(/^\/(\w+)(?:@(\w+))?/);
  if (!m?.[1]) return false;
  return !m[2] || m[2].toLowerCase() === (botUsername ?? '').toLowerCase();
}

/** Run one entry through the pipeline as tracking-only bookkeeping. */
async function trackEntry(chatId: number, entry: PendingEntry, batchSize: number, suppressed: boolean): Promise<void> {
  try {
    await processPipeline({
      type: 'message',
      chatId,
      messageId: entry.messageId,
      update: entry.update,
      enqueuedAt: entry.enqueuedAt,
      coalesce: {
        batchSize,
        isLastInBatch: false,
        flushReason: entry.direct ? 'direct_interaction' : 'window',
      },
      skipReply: suppressed ? true : undefined,
    });
  } catch (err) {
    logger.error({ err, chatId, messageId: entry.messageId }, 'Turn: tracking entry failed');
  }
}

/**
 * Run a judged entry with G3 interrupt semantics: register an interruptible
 * generation; on AI_ABORTED wait the quiet period, ingest the messages that
 * caused the interrupt, then replan anchored on the newest one with the
 * timing gate bypassed (MaiBot forced-continue).
 */
async function runJudgedEntry(
  chatId: number,
  entry: PendingEntry,
  batchSize: number,
  epoch: number,
  burstMessageIds: number[],
): Promise<void> {
  const e = env();
  let current = entry;
  let currentBatch = batchSize;
  let currentBurstIds = burstMessageIds;
  let gateBypass = false;
  let replans = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const controller = registerGeneration(chatId, epoch);
    let interrupted = false;
    try {
      await processPipeline({
        type: 'message',
        chatId,
        messageId: current.messageId,
        update: current.update,
        enqueuedAt: current.enqueuedAt,
        coalesce: {
          batchSize: currentBatch,
          isLastInBatch: true,
          flushReason: current.direct ? 'direct_interaction' : 'window',
        },
        turnContext: {
          signal: controller.signal,
          epoch,
          // wait 回访跳过 gate:刚因 wait 沉默过,再问 gate 多半又是沉默
          gateBypass: gateBypass || current.waitReplay === true,
          isReplan: replans > 0,
          isWaitReplay: current.waitReplay === true,
          burstMessageIds: currentBurstIds.length > 1 ? currentBurstIds : undefined,
        },
      });
      return;
    } catch (err) {
      if (!isAbortError(err) || !e.TURN_ABORT_ENABLED || replans >= maxReplans()) {
        if (isAbortError(err)) {
          // 重规划预算耗尽:静默放弃这一回合的发言(消息已入上下文,
          // 下一回合会带着完整语境重新决策)。
          logger.info({ chatId, replans }, 'Turn: replan budget exhausted, dropping reply');
          return;
        }
        throw err;
      }
      interrupted = true;
      replans++;

      // 等用户这一波消息发完(MaiBot post-interrupt 1s 静默期)
      await waitForMessageQuiet(chatId, e.TURN_INTERRUPT_QUIET_MS);

      // 消化打断期间的新消息:非锚点 tracking-only,锚点选择与 runChatTurn
      // 一致——**direct 优先**(最后一条 reply-to-bot/@bot),否则取最新的
      // 非编辑条目。无条件取 fresh.at(-1) 会让"用户 reply bot + 别人紧跟
      // 插话"场景下点名被挤掉,bot 跑去回应插话的话题,原 reply-to-bot
      // 用户答非所问(2026-06-12 用户反馈,日志实例 msg 75953"糖")。
      // burst 视野扩展为「原 burst + 打断新增」(都已在上下文里)
      const fresh = await drainPending(chatId);
      if (fresh.length > 0) {
        let anchorIdx = -1;
        for (let i = fresh.length - 1; i >= 0; i--) {
          if (fresh[i]!.direct === true) {
            anchorIdx = i;
            break;
          }
        }
        if (anchorIdx === -1) {
          for (let i = fresh.length - 1; i >= 0; i--) {
            if (fresh[i]!.isEdit !== true) {
              anchorIdx = i;
              break;
            }
          }
        }
        if (anchorIdx === -1) anchorIdx = fresh.length - 1;
        for (let i = 0; i < fresh.length; i++) {
          if (i === anchorIdx) continue;
          await trackEntry(chatId, fresh[i]!, fresh.length, false);
        }
        current = fresh[anchorIdx]!;
        currentBatch = fresh.length;
        currentBurstIds = [
          ...currentBurstIds,
          ...fresh.map((f) => f.messageId).filter((id): id is number => id !== undefined),
        ];
      }
      // 无论是否有新消息,重规划都跳过 gate(打断已证明此刻该说话)
      gateBypass = true;
      logger.info(
        { chatId, replans, newAnchor: current.messageId, freshCount: fresh.length },
        'Turn: replanning after interrupt',
      );
    } finally {
      clearGeneration(chatId, controller, interrupted);
    }
  }
}

/**
 * Run one cognition turn for a chat. Invoked by the BullMQ worker for
 * type='chat_turn' jobs. Idempotent: a duplicate/raced turn drains an
 * empty buffer and exits.
 */
export async function runChatTurn(data: MessageJobData, jobId?: string): Promise<void> {
  const chatId = data.chatId;
  const turnPayload = data.turn;
  const start = performance.now();

  // 注意:运行期间**不**清 scheduledJobId —— meta 必须继续指向本(active)
  // job,这样回合期间新消息走 scheduleTurn → getState()==='active' →
  // markDirty,由本回合收尾时统一再排程。开局就清会让新消息另建并行
  // turn job → 同群双回合并发(codex review #1)。job 完成后由
  // removeOnComplete 移除,后续 getJob 落空自然走新建路径。

  const drained = await drainPending(chatId);
  if (drained.length === 0) {
    // Raced duplicate turn, or a wait/proactive trigger with nothing buffered.
    logger.debug({ chatId, trigger: turnPayload?.trigger }, 'Turn fired with empty buffer, exiting');
    return;
  }

  // G5: wait 回访让位 — 若同批里有比锚点更新的真实消息,旧锚点退位
  // (它的内容早已在上下文里;MaiBot timeout-with-new-messages 重锚定语义),
  // 但它的 id 仍留在 burst 窗口里供模型选目标。
  const hasFresh = drained.some((en) => !en.waitReplay);
  const displacedReplayIds = hasFresh
    ? drained.filter((en) => en.waitReplay).map((en) => en.messageId).filter((id): id is number => id !== undefined)
    : [];
  let entries = hasFresh ? drained.filter((en) => !en.waitReplay) : drained;

  // 积压保护:调度故障/停机恢复后 pending 可能上千条;一个 turn job 顺序
  // 消化会超过 BullMQ lockDuration → stalled 重跑 → 重复处理。只保最新
  // MAX_TURN_BURST 条,更老的明确丢弃并记日志(不静默截断)。
  // direct 条目(@bot/回复 bot)即使在被截断的旧段里也要保留(最多 5 条)——
  // 否则 hasDirect=false,WAIT/STOP 不唤醒、锚点退化(cursor review #4)。
  const MAX_TURN_BURST = 30;
  if (entries.length > MAX_TURN_BURST) {
    const recent = entries.slice(-MAX_TURN_BURST);
    const older = entries.slice(0, -MAX_TURN_BURST);
    const olderDirects = older.filter((en) => en.direct === true).slice(-5);
    const droppedEntries = older.filter((en) => !olderDirects.includes(en));
    logger.warn(
      { chatId, dropped: droppedEntries.length, kept: recent.length, keptOlderDirects: olderDirects.length },
      'Turn burst overflow — dropping oldest backlog entries',
    );
    // 被丢弃的条目不再回复,但做轻量入册(仅 format+context 保存,跳过
    // media/judge/副作用)—— 否则停机恢复后上下文出现大段空洞,后续回复
    // 像失忆(review-workflow:overflow drops bookkeeping)。
    try {
      const { formatMessage } = await import('../formatter.js');
      const { addMessage } = await import('../context/manager.js');
      for (const en of droppedEntries) {
        const f = formatMessage(en.update);
        if (f) await addMessage(chatId, f).catch(() => {});
      }
    } catch (err) {
      logger.debug({ err, chatId }, 'Overflow lightweight bookkeeping failed (non-critical)');
    }
    entries = [...olderDirects, ...recent];
  }

  const epoch = await bumpEpoch(chatId);
  const e = env();
  const hasDirect = entries.some((entry) => entry.direct);

  // ── WAIT/STOP suppression (legacy ingress parity) ──
  // direct 在场 → 唤醒;否则整批 tracking-only,等 direct/wait 到期唤醒。
  let suppressed = false;
  if (e.TIMING_GATE_ENABLED) {
    try {
      const chatState = await getChatState(chatId);
      if (chatState.state === 'WAIT' || chatState.state === 'STOP') {
        if (hasDirect) {
          await transitionToRunning(chatId);
        } else {
          suppressed = true;
        }
      }
    } catch (err) {
      logger.warn({ err, chatId }, 'Turn: getChatState failed, treating as RUNNING');
    }
  }

  logger.debug(
    {
      chatId, epoch, burstSize: entries.length, hasDirect, suppressed,
      trigger: turnPayload?.trigger, directPriority: turnPayload?.directPriority,
    },
    'Turn started',
  );

  // ── Process the burst through the existing pipeline ──
  const burstMessageIds = [
    ...displacedReplayIds,
    ...entries.map((en) => en.messageId).filter((id): id is number => id !== undefined),
  ];

  // 斜杠命令是**事务性请求**,每条都必须有回执:两个人同窗 /checkin,
  // 单锚点会吞掉前一个人的签到(命令回执只在 judged 路径触发 —— L0
  // whitelisted_command → 拦截器,tracking-only 永远到不了)。命令逐条
  // judged,确定性拦截无 LLM 浪费;"每回合一个锚点"的预算只约束聊天式回复。
  const judgedIdx = new Set<number>();
  // 聊天式锚点:有 direct 取最后一条 direct,否则取末尾最新的**非编辑**
  // 条目。(旧 debounce 语义会让 direct 和末尾各判一次 → 同回合可能双回复;
  // burst 窗口已让模型看到整波,单锚点足够。)
  // 编辑永不当默认锚点:锚到一条改旧消息上,bot 会把陈年消息当成刚发的
  // 接话(review P1 #0/#3)。改出 @bot 的编辑带 direct,走上面的 direct 扫描。
  // 全是被动编辑的回合 → 无锚点,整批 tracking-only 纯入册。
  if (!suppressed) {
    for (let i = 0; i < entries.length; i++) {
      if (isCommandEntry(entries[i]!, e.BOT_USERNAME)) judgedIdx.add(i);
    }
    let anchorIndex = -1;
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i]!.direct === true && !judgedIdx.has(i)) {
        anchorIndex = i;
        break;
      }
    }
    if (anchorIndex === -1) {
      for (let i = entries.length - 1; i >= 0; i--) {
        if (entries[i]!.isEdit !== true && !judgedIdx.has(i)) {
          anchorIndex = i;
          break;
        }
      }
    }
    if (anchorIndex !== -1) judgedIdx.add(anchorIndex);
  }

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;

    try {
      if (judgedIdx.has(i)) {
        await runJudgedEntry(chatId, entry, entries.length, epoch, burstMessageIds);
      } else {
        await trackEntry(chatId, entry, entries.length, suppressed);
      }
    } catch (err) {
      // One bad entry must not kill the rest of the burst.
      logger.error({ err, chatId, messageId: entry.messageId }, 'Turn: pipeline failed for entry');
    }
  }

  // ── Self-reschedule when messages landed mid-turn ──
  // 顺序关键(丢唤醒窗口,review-workflow P1):必须**先**清掉指向本 job 的
  // meta 指针,**再**读 dirty/pending —— 这样窗口期内赶到的 ingress 要么
  // 走 markDirty(指针还在,被随后的 recheck 捕获),要么指针已清、自建新
  // job 自救。反过来读-后-清会留下"读完之后、清之前"标的 dirty 永远无人
  // 消费。forceNew 必须:普通排程对 active 的本 job 只会 markDirty。
  await clearScheduledJob(chatId, jobId);
  const wasDirty = await clearDirty(chatId);
  const stillPending = await pendingCount(chatId);
  if (wasDirty || stillPending > 0) {
    // P1:缓冲里有 direct(@/回复 bot 在回合活跃期到达,被降级成 dirty)
    // → 立即开火,不罚去抖窗口
    const { hasPendingDirect } = await import('./buffer.js');
    const direct = await hasPendingDirect(chatId).catch(() => false);
    await scheduleTurn(chatId, { trigger: direct ? 'direct' : 'message', direct, forceNew: true });
  }

  logger.debug(
    { chatId, epoch, burstSize: entries.length, rescheduled: wasDirty || stillPending > 0, totalMs: Math.round(performance.now() - start) },
    'Turn complete',
  );
}
