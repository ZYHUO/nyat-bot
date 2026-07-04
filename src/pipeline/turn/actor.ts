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
  appendPending,
} from './buffer.js';
import { hasDeferBudget } from '../timing/defer.js';
import { registerGeneration, clearGeneration } from './abort-registry.js';
import { waitForMessageQuiet } from './quiet-period.js';
import { scheduleTurn } from '../../queue/turn-scheduler.js';
import { getChatState, transitionToRunning } from '../timing/chat-runtime.js';
import type { PendingEntry } from './types.js';
import { AIError } from '../../shared/errors.js';
import { selectActiveObligation } from './obligation-select.js';
import { expireStaleObligations } from './obligation-store.js';
import { env } from '../../env.js';
import { logger } from '../../shared/logger.js';
import {
  pickMultiAnchorGroups,
  entryUid,
  entryDate,
  type AnchorCandidate,
} from './anchor-select.js';
import { formatMessage } from '../formatter.js';
import { deriveTopicKey } from './obligation-detect.js';

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


function buildActiveObligationContext(entries: PendingEntry[]): {
  obligationId?: string;
  obligationTargetUid?: number;
  obligationStrong?: boolean;
} {
  const candidates = entries
    .filter((e) => e.obligationId)
    .map((e) => ({
      id: e.obligationId!,
      targetUid: e.obligationTargetUid ?? 0,
      mustReplyStrong: e.obligationStrong === true,
      directInteraction: e.direct === true,
      priority: e.obligationStrong ? 100 : 50,
      state: 'pending' as const,
      chatId: e.chatId,
      anchorMessageId: e.messageId ?? 0,
      anchorUid: e.obligationTargetUid ?? 0,
      anchorFullName: '',
      targetFullName: '',
      kind: 'judge_reply' as const,
      createdAt: e.enqueuedAt,
      updatedAt: e.enqueuedAt,
      relatedMessageIds: e.messageId ? [e.messageId] : [],
      triggerUids: e.obligationTargetUid ? [e.obligationTargetUid] : [],
    }));
  const selected = selectActiveObligation(candidates).active;
  if (!selected) return {};
  const source = entries.find((e) => e.obligationId === selected.id);
  return {
    obligationId: selected.id,
    obligationTargetUid: source?.obligationTargetUid,
    obligationStrong: source?.obligationStrong === true,
  };
}

function mergeObligationContext(
  base: { obligationId?: string; obligationTargetUid?: number; obligationStrong?: boolean },
  fallback?: { obligationId?: string; obligationTargetUid?: number; obligationStrong?: boolean },
): { obligationId?: string; obligationTargetUid?: number; obligationStrong?: boolean } {
  return {
    obligationId: base.obligationId ?? fallback?.obligationId,
    obligationTargetUid: base.obligationTargetUid ?? fallback?.obligationTargetUid,
    obligationStrong: base.obligationStrong ?? fallback?.obligationStrong,
  };
}

function isAbortError(err: unknown): boolean {
  // AI 调用层把调用方打断归一成 AIError/AI_ABORTED;但 signal.throwIfAborted()
  // 抛的是裸 TurnInterrupt(name='TurnInterrupt',message 不含 'abort'),旧判据
  // 漏接 → 正常打断被当真错误上抛到 worker。两种形状都认。
  return (
    (err instanceof AIError && err.code === 'AI_ABORTED') ||
    (err instanceof Error && (err.name === 'TurnInterrupt' || err.name === 'Shutdown'))
  );
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
    // review #4:一条 wait/defer 回放条目若在 drain 时恰好落进 WAIT 抑制
    // (per-person waitTriggerUids 命中,或 suppressAll/STOP),会被路由到这里
    // 而不是 runJudgedEntry —— 首轮已经跑过完整 bookkeeping,这里必须显式
    // 跳过,否则 addMessage(无 messageId 去重的 RPUSH)会把同一条消息第二次
    // 写进上下文,写手看到"重复发言",活跃度/统计计数也翻倍。
    const isReplay = entry.waitReplay === true || entry.deferReplay === true;
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
      turnContext: isReplay
        ? { isWaitReplay: entry.waitReplay === true, isDeferReplay: entry.deferReplay === true }
        : undefined,
    });
  } catch (err) {
    logger.error({ err, chatId, messageId: entry.messageId }, 'Turn: tracking entry failed');
  }
}

/**
 * Run a slash-command entry as a transaction: it MUST produce its receipt and must
 * never be interrupted/replanned away (几个人同窗 /checkin → 每个人都要拿到自己的签到)。
 * 不注册可打断生成、不进重规划循环 —— 跑一遍 processPipeline 就完。
 */
async function runCommandEntry(
  chatId: number,
  entry: PendingEntry,
  batchSize: number,
  epoch: number,
  burstMessageIds: number[],
  obligationCtx?: { obligationId?: string; obligationTargetUid?: number; obligationStrong?: boolean },
): Promise<void> {
  try {
    await processPipeline({
      type: 'message',
      chatId,
      messageId: entry.messageId,
      update: entry.update,
      enqueuedAt: entry.enqueuedAt,
      coalesce: {
        batchSize,
        isLastInBatch: true,
        flushReason: entry.direct ? 'direct_interaction' : 'window',
      },
      turnContext: {
        // 无 signal → 不可打断;命令本就直接交互、跳 gate
        epoch,
        obligationId: obligationCtx?.obligationId ?? entry.obligationId,
        obligationTargetUid: obligationCtx?.obligationTargetUid ?? entry.obligationTargetUid,
        obligationStrong: obligationCtx?.obligationStrong ?? entry.obligationStrong,
        gateBypass: true,
        isReplan: false,
        sleepCatchup: entry.sleepCatchup === true,
        burstMessageIds: burstMessageIds.length > 1 ? burstMessageIds : undefined,
      },
    });
  } catch (err) {
    logger.error({ err, chatId, messageId: entry.messageId }, 'Turn: command entry failed');
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
  opts?: {
    skipGateCooldown?: boolean;
    burstUids?: number[];
    obligationCtx?: { obligationId?: string; obligationTargetUid?: number; obligationStrong?: boolean };
    /** P2-F:wait 回访元数据(写手提示"你刚等了 N 秒"用)。 */
    waitResume?: { waitSec?: number; hadNewMessages: boolean };
    /** review #10:回合开始时的 timing state 快照(多锚点各组共用)。 */
    timingSnapshot?: Awaited<ReturnType<typeof getChatState>>;
    /** 分人回复修复:回合开始时刻(ms),仅多锚点回合设置。 */
    turnStartedAt?: number;
    /** 分人回复修复:本回合是否多锚点。 */
    isMultiAnchorTurn?: boolean;
  },
): Promise<void> {
  const e = env();
  // 命令是事务 → 非打断单跑,绝不进重规划锚点逻辑(否则同窗多命令被单锚点吞掉)
  if (isCommandEntry(entry, e.BOT_USERNAME)) {
    await runCommandEntry(chatId, entry, batchSize, epoch, burstMessageIds, opts?.obligationCtx);
    return;
  }
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
          obligationId: opts?.obligationCtx?.obligationId ?? current.obligationId,
          obligationTargetUid: opts?.obligationCtx?.obligationTargetUid ?? current.obligationTargetUid,
          obligationStrong: opts?.obligationCtx?.obligationStrong ?? current.obligationStrong,
          // wait 回访跳过 gate:刚因 wait 沉默过,再问 gate 多半又是沉默。
          // P0-B 注意:deferReplay **不**跳过 gate —— defer 的意义就是到点重评。
          gateBypass: gateBypass || current.waitReplay === true,
          isReplan: replans > 0,
          // isWaitReplay 只跳过 bookkeeping**和 judge**(gate 选 WAIT 而非
          // NO_ACTION 时已经隐含 REPLY 成立,只是节奏未到)。
          isWaitReplay: current.waitReplay === true,
          // review #10(critical):defer 曾误共用 isWaitReplay,导致强制
          // REPLY(rule=turn_replan∈DIRECT_INTERACTION_RULES)→ isDirectInteraction
          // → gate 在 cooldown 检查前就 short-circuit,heart/judge 全被跳过——
          // defer 变成"无条件延迟回复",把这轮修复的节流意图整个废掉。
          // isDeferReplay 只跳 bookkeeping(首轮已入册),judge/heart 照常全跑,
          // 这才是"到点重评"的本意。
          isDeferReplay: current.deferReplay === true,
          sleepCatchup: current.sleepCatchup === true,
          deferCount: current.deferCount,
          waitResume: opts?.waitResume,
          timingStateSnapshot: opts?.timingSnapshot,
          turnStartedAt: opts?.turnStartedAt,
          isMultiAnchorTurn: opts?.isMultiAnchorTurn,
          burstMessageIds: currentBurstIds.length > 1 ? currentBurstIds : undefined,
          // 多锚点同场兄弟:跳过心流冷却,否则组2+ 会被组1 的 no_action 冷却误杀。
          skipGateCooldown: opts?.skipGateCooldown ?? false,
          // burstUid 集合(actor 算好直传,不靠 pipeline 侧 30 条窗口)。
          burstUids: opts?.burstUids,
        },
      });
      return;
    } catch (err) {
      if (!isAbortError(err) || !e.TURN_ABORT_ENABLED || replans >= maxReplans()) {
        if (isAbortError(err)) {
          // 重规划预算耗尽:不再终局丢弃(48h 28 次全灭,且第 3 次 abort 多来自
          // supersede 竞态而非用户打断)。MaiBot 不变量:打断只推迟、不取消 ——
          // 把当前锚点作为 defer 回放重新入 pending(跳 bookkeeping、照常
          // judge/heart),回合收尾的 stillPending 检查会自动重排;deferCount
          // 防无限循环,预算耗尽才真正放弃。
          if (hasDeferBudget(current.deferCount)) {
            const requeued = await appendPending({
              ...current,
              deferReplay: true,
              deferCount: (current.deferCount ?? 0) + 1,
            }).then(() => true).catch(() => false);
            logger.info(
              { chatId, replans, messageId: current.messageId, requeued },
              requeued
                ? 'Turn: replan budget exhausted, re-queued as defer replay'
                : 'Turn: replan budget exhausted, re-queue failed — dropping reply',
            );
            return;
          }
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
        // 命令不当聊天锚点 —— 它们逐条出回执(事务),不被单锚点吞掉
        const isCmd = fresh.map((f) => isCommandEntry(f, e.BOT_USERNAME));
        let anchorIdx = -1;
        for (let i = fresh.length - 1; i >= 0; i--) {
          if (fresh[i]!.direct === true && !isCmd[i]) {
            anchorIdx = i;
            break;
          }
        }
        if (anchorIdx === -1) {
          for (let i = fresh.length - 1; i >= 0; i--) {
            if (fresh[i]!.isEdit !== true && !isCmd[i]) {
              anchorIdx = i;
              break;
            }
          }
        }
        for (let i = 0; i < fresh.length; i++) {
          if (isCmd[i]) {
            await runCommandEntry(chatId, fresh[i]!, fresh.length, epoch, currentBurstIds); // 命令逐条出回执
          } else if (i !== anchorIdx) {
            await trackEntry(chatId, fresh[i]!, fresh.length, false);
          }
        }
        // 有新的聊天锚点 → 重规划到它;打断全来自命令(anchorIdx===-1)→ 保留原 current 重试原回复
        if (anchorIdx !== -1) {
          current = fresh[anchorIdx]!;
          currentBatch = fresh.length;
        }
        // L6: 只把与当前锚点同 uid 的 fresh id 并入本组 burstIds,避免跨人
        // replan 时写手 reply_to 指到别人消息上(多锚点场景)。锚点若切到
        // 别人(direct 优先),则以新锚点 uid 为准 —— 写手最可能回最新锚点。
        const anchorUid = entryUid(current);
        currentBurstIds = [
          ...currentBurstIds,
          ...fresh
            .filter((f) => entryUid(f) === anchorUid)
            .map((f) => f.messageId)
            .filter((id): id is number => id !== undefined),
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

  // G5: wait/defer 回访让位 — 若同批里有比锚点更新的真实消息,旧锚点退位
  // (它的内容早已在上下文里;MaiBot timeout-with-new-messages 重锚定语义),
  // 但它的 id 仍留在 burst 窗口里供模型选目标。P0-B 的 deferReplay 同语义。
  const hasFresh = drained.some((en) => !en.waitReplay && !en.deferReplay);
  const displacedReplayIds = hasFresh
    ? drained.filter((en) => en.waitReplay || en.deferReplay).map((en) => en.messageId).filter((id): id is number => id !== undefined)
    : [];
  let entries = hasFresh ? drained.filter((en) => !en.waitReplay && !en.deferReplay) : drained;

  // P2-F: wait 回访元数据 —— 提示写手"你刚才决定等了 N 秒,期间有/无新消息"。
  // 锚点被新消息挤掉时提示挂到新锚点上(对齐 MaiBot 把 wait-completed 标记
  // 写进共享历史:谁接棒谁看得见)。
  // review #8 修正:睡眠补回也复用 waitReplay 标记,靠 sleepCatchup 排除
  // (不靠 trigger)。review #2/#8 再修正:曾经加过 `turnPayload?.trigger
  // === 'wait_timeout'` 这道闸,但 handleWaitResume 排的 scheduleTurn 不带
  // forceNew ——若此刻已有 delayed 回合,changeDelay(0) 复用它、trigger 仍是
  // 原来的 'message';若有 active 回合,markDirty 收尾重排的 trigger 是
  // 'message'/'direct'。两种情况都会让 trigger 检查判假,回访提示在"群里
  // 一直有人说话"这个 P2-F 最该生效的场景反而失效。改回直接认条目自身的
  // waitReplay 标记,不看触发它的 turn 是靠什么 trigger 排的。
  // "期间有无新消息"不能只看本回合 drain 批 —— 窗口期消息早被中间回合
  // 消化,要对照 activity 时间线(wait 开始之后群里有没有人说过话)。
  let waitResumeInfo: { waitSec?: number; hadNewMessages: boolean } | undefined;
  const waitReplayEntry = drained.find((en) => en.waitReplay === true && en.sleepCatchup !== true);
  if (waitReplayEntry !== undefined) {
    let hadNewMessages = hasFresh;
    if (!hadNewMessages && waitReplayEntry.waitStartedAt !== undefined) {
      try {
        const { getRecentTimestamps } = await import('../../tracking/activity.js');
        const windowSec = Math.ceil((Date.now() - waitReplayEntry.waitStartedAt) / 1000) + 5;
        const timestamps = await getRecentTimestamps(chatId, windowSec);
        hadNewMessages = timestamps.some((ts) => ts * 1000 > waitReplayEntry.waitStartedAt!);
      } catch { /* 保守沿用 hasFresh */ }
    }
    waitResumeInfo = { waitSec: waitReplayEntry.waitSec, hadNewMessages };
  }

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

  // ── WAIT/STOP suppression ──
  // per-person(TURN_WAIT_PER_PERSON):WAIT 只抑制触发者集合(waitTriggerUids)的
  // 后续,别人的条目不抑制、正常进多锚点 judge。心流 wait 本意就是"等TA
  // 说完",抑制整群是过度抑制。STOP 仍 legacy 整批抑制(actor 模式极少进
  // STOP)。direct 在场 → 唤醒整群(保留原逃生口)。
  // L5 guard:部署前已存在的 WAIT 无 waitTriggerUids → 落到 else 的 legacy
  // 整批抑制,等老 wait 自然过期;只有新 wait(带 uid 集合)走 per-person。
  let suppressedUidSet: Set<number> | undefined;
  let waitTopicKey: string | undefined;
  let suppressAll = false;
  // review #10:回合开始时的 timing state 快照,传给本回合所有组共用 ——
  // 组1 中途写入的 no_action/wait 不会误伤组2(替代旧 skipGateCooldown
  // 整层旁路);回合开始前已存在的冷却/退避/阈值对所有组照常生效。
  let timingSnapshot: Awaited<ReturnType<typeof getChatState>> | undefined;
  if (e.TIMING_GATE_ENABLED) {
    try {
      const chatState = await getChatState(chatId);
      timingSnapshot = chatState;
      if (chatState.state === 'WAIT' || chatState.state === 'STOP') {
        if (hasDirect) {
          await transitionToRunning(chatId);
        } else if (chatState.state === 'WAIT' && e.TURN_WAIT_PER_PERSON && chatState.waitTriggerUids !== undefined) {
          suppressedUidSet = new Set(chatState.waitTriggerUids);
          waitTopicKey = chatState.waitTopicKey;
        } else {
          suppressAll = true;
        }
      }
    } catch (err) {
      logger.warn({ err, chatId }, 'Turn: getChatState failed, treating as RUNNING');
    }
  }
  const isEntrySuppressed = (entry: PendingEntry): boolean => {
    if (suppressAll) return true;
    if (suppressedUidSet !== undefined) {
      if (!suppressedUidSet.has(entryUid(entry))) return false;
      if (!waitTopicKey) return true;
      const formatted = formatMessage(entry.update);
      const entryTopicKey = formatted ? deriveTopicKey(formatted) : undefined;
      return entryTopicKey === waitTopicKey;
    }
    return false;
  };

  await expireStaleObligations(chatId).catch(() => {});

  logger.debug(
    {
      chatId, epoch, burstSize: entries.length, hasDirect, suppressAll,
      suppressedUidSet: suppressedUidSet ? [...suppressedUidSet] : undefined,
      trigger: turnPayload?.trigger, directPriority: turnPayload?.directPriority,
    },
    'Turn started',
  );

  // ── Process the burst through the existing pipeline ──
  const burstMessageIds = [
    ...displacedReplayIds,
    ...entries.map((en) => en.messageId).filter((id): id is number => id !== undefined),
  ];

  // 斜杠命令是**事务性请求**,每条都必须有回执:逐条 judged,不参与锚点预算。
  const judgedIdx = new Set<number>();
  const obligationCtx = mergeObligationContext(buildActiveObligationContext(entries), {
    obligationId: turnPayload?.obligationId,
    obligationTargetUid: turnPayload?.obligationTargetUid,
    obligationStrong: turnPayload?.obligationStrong,
  });
  for (let i = 0; i < entries.length; i++) {
    if (isCommandEntry(entries[i]!, e.BOT_USERNAME)) judgedIdx.add(i);
  }

  // 候选锚点条目:非命令、且未被 per-person 抑制。
  const candidateIdx: number[] = [];
  for (let i = 0; i < entries.length; i++) {
    if (!judgedIdx.has(i) && !isEntrySuppressed(entries[i]!)) candidateIdx.push(i);
  }

  // burst 是否多人 → 走多锚点还是单锚点。单人 burst 走原单锚点逻辑(零回归)。
  let multiAnchor = false;
  if (e.TURN_MULTI_ANCHOR_ENABLED && candidateIdx.length > 0 && !suppressAll) {
    const uids = new Set<number>();
    for (const i of candidateIdx) {
      uids.add(entryUid(entries[i]!));
      if (uids.size > 1) break;
    }
    multiAnchor = uids.size > 1;
  }
  // 分人回复修复:回合开始时刻,给多锚点各组的 engagement 计算当"回合前"基准
  // (见 runJudgedEntry opts.turnStartedAt 用法 / pipeline.ts engagement 过滤)。
  const turnStartedAtMs = Date.now();

  // 每发送者的 messageId 列表(多锚点给每组 runJudgedEntry 传本组 burstIds,
  // 写手 reply_to 自然落在本人消息上 → 治"回错人")。只收候选(非命令、非抑制)
  // 条目,排除命令 messageId 混入 burstIds 导致回复挂到命令消息下。
  const idsByUid = new Map<number, number[]>();
  if (multiAnchor) {
    for (const i of candidateIdx) {
      const en = entries[i]!;
      if (en.messageId === undefined) continue;
      const uid = entryUid(en);
      let arr = idsByUid.get(uid);
      if (!arr) { arr = []; idsByUid.set(uid, arr); }
      arr.push(en.messageId);
    }
  }

  if (!suppressAll) {
    if (multiAnchor) {
      const candidates: AnchorCandidate[] = candidateIdx.map((i) => {
        const en = entries[i]!;
        return {
          idx: i,
          uid: entryUid(en),
          direct: en.direct === true,
          isEdit: en.isEdit === true,
          ts: entryDate(en),
        };
      });
      const budget = e.TURN_MULTI_ANCHOR_MAX;
      // direct 优先 + 最新时间倒序,总共取前 budget 组(direct 也受预算约束,
      // 超过 budget 人 @bot 时只回最新的 budget 个,兑现"每回合最多回 N 人")。
      const picked = pickMultiAnchorGroups(candidates, budget);
      for (const idx of picked) judgedIdx.add(idx);
      // info 级(原 debug 从未在生产记到过,分人回复问题排障需要看多锚点触发频率)
      logger.info(
        { chatId, multiAnchor: true, groups: new Set(candidates.map((c) => c.uid)).size, judged: judgedIdx.size, budget },
        'Turn: multi-anchor groups selected',
      );
    } else if (candidateIdx.length > 0) {
      // 单锚点(原逻辑):最后一条 direct,否则最后一条非编辑。
      let anchorIndex = -1;
      for (let i = candidateIdx.length - 1; i >= 0; i--) {
        const idx = candidateIdx[i]!;
        if (entries[idx]!.direct === true) { anchorIndex = idx; break; }
      }
      if (anchorIndex === -1) {
        for (let i = candidateIdx.length - 1; i >= 0; i--) {
          const idx = candidateIdx[i]!;
          if (entries[idx]!.isEdit !== true) { anchorIndex = idx; break; }
        }
      }
      if (anchorIndex !== -1) judgedIdx.add(anchorIndex);
    }
  }

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;

    try {
      if (judgedIdx.has(i)) {
        const groupBurstIds = multiAnchor
          ? (idsByUid.get(entryUid(entry)) ?? burstMessageIds)
          : burstMessageIds;
        // burstUid 集合(L3):多锚点 → 本组单人 [uid];单锚点 → 整 burst 去重 uid。
        // actor 直传,不依赖 pipeline 侧 recentMessages 的 30 条窗口。
        const groupBurstUids = multiAnchor
          ? [entryUid(entry)]
          : [...new Set(entries.map((en) => entryUid(en)))];
        await runJudgedEntry(chatId, entry, entries.length, epoch, groupBurstIds, {
          burstUids: groupBurstUids,
          obligationCtx,
          waitResume: waitResumeInfo,
          timingSnapshot,
          turnStartedAt: multiAnchor ? turnStartedAtMs : undefined,
          isMultiAnchorTurn: multiAnchor,
        });
      } else {
        await trackEntry(chatId, entry, entries.length, isEntrySuppressed(entry));
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
